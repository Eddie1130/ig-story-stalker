import html
import time
from http.client import HTTPException
from pathlib import Path
from threading import Thread

from requests import RequestException

from upload.telegram import Telegram
from core.tiktok_api import TikTokAPI
from utils.logger_manager import logger
from utils.recorder_config import RecorderConfig
from utils.video_management import VideoManagement
from utils.custom_exceptions import LiveNotFound, UserLiveError, TikTokRecorderError
from utils.enums import Mode, Error, TimeOut, TikTokError


class TikTokRecorder:
    def __init__(self, config: RecorderConfig):
        self.tiktok = TikTokAPI(proxy=config.proxy, cookies=config.cookies)

        self.url = config.url
        self.user = config.user
        self.room_id = config.room_id
        self.mode = config.mode
        self.automatic_interval = config.automatic_interval
        self.duration = config.duration
        self.output = config.output
        self.bitrate = config.bitrate
        self.ffmpeg_path = config.ffmpeg_path
        self.use_telegram = config.use_telegram
        self._proxy = config.proxy
        self._cookies = config.cookies

        # Recording failure Telegram alerts.
        # Same user + same error is limited to
        # one alert every 10 minutes.
        self._failure_notify_times = {}
        self._failure_notify_cooldown_seconds = 600

    def _notify_recording_failure(
        self,
        user,
        reason,
    ):
        """
        Send a Telegram alert for recording failures.

        Repeated identical failures are rate-limited
        to avoid a notification every polling cycle.
        """
        if not self.use_telegram:
            return

        username = str(
            user or self.user or "unknown"
        )

        reason_text = " ".join(
            str(reason).split()
        )

        if not reason_text:
            reason_text = "Unknown recording error"

        # Keep messages reasonably short and
        # avoid using signed URLs in Telegram.
        reason_text = reason_text[:700]

        key = (
            username,
            reason_text[:180],
        )

        now = time.monotonic()

        last = self._failure_notify_times.get(
            key,
            0,
        )

        if (
            now - last
            < self._failure_notify_cooldown_seconds
        ):
            return

        self._failure_notify_times[key] = now

        safe_user = html.escape(username)
        safe_reason = html.escape(
            reason_text
        )

        try:
            Telegram().send_message(
                "⚠️ <b>TikTok recording failed</b>\n\n"
                f"👤 @{safe_user}\n"
                f"❌ {safe_reason}\n\n"
                "🔁 Automatic monitoring will continue."
            )

            logger.info(
                f"Recording failure notification sent "
                f"for @{username}."
            )

        except Exception as error:
            logger.warning(
                "Unable to send recording failure "
                f"notification: {error}"
            )

    def _tiktok_alert(self, kind, reason, stage=None):
        """Send deduplicated, HTML-escaped notifications without leaking URLs."""
        import html as _html
        import re as _re

        if not self.use_telegram:
            return

        now = time.monotonic()
        times = getattr(self, '_tiktok_alert_times', None)
        if times is None:
            times = {}
            self._tiktok_alert_times = times

        room = str(getattr(self, 'room_id', '') or '')
        key = (kind, room if kind in ('failed', 'interrupted') else '')
        cooldown = 1800 if kind == 'monitoring' else (600 if kind in ('failed', 'interrupted') else 0)
        if now - times.get(key, -1e12) < cooldown:
            return

        titles = {
            'monitoring': '⚠️ <b>TikTok monitoring failed</b>',
            'recovered': '✅ <b>TikTok monitoring recovered</b>',
            'failed': '🚨 <b>TikTok recording failed</b>',
            'interrupted': '🚨 <b>TikTok recording interrupted</b>',
        }
        title = titles.get(kind)
        if not title:
            return

        # No signed URLs or query-string secrets in Telegram alerts.
        detail = _re.sub(r'https?://\S+', '[URL]', str(reason))
        detail = _re.sub(r'(?i)(sessionid|msToken|X-Bogus|X-Gnarly|X-Dynosaur)\s*[=:]\s*\S+', r'\1=[REDACTED]', detail)
        detail = _html.escape(' '.join(detail.split())[:400])
        user = _html.escape(str(self.user or 'unknown'))
        stage_text = _html.escape(str(stage or ''))
        lines = [title, '', f'👤 @{user}']
        if stage_text:
            lines.append(f'📍 Stage: {stage_text}')
        if kind != 'recovered':
            lines.append(f'❌ {detail}')
        if kind == 'monitoring':
            lines.append('🔁 Automatic monitoring retries will continue.')
        elif kind == 'failed':
            lines.append('🔁 LIVE detected; automatic retry will continue.')
        elif kind == 'interrupted':
            lines.append('💾 Any partial recording will be preserved if possible.')
        else:
            lines.append('✅ LIVE monitoring is working again.')

        try:
            Telegram().send_message('\n'.join(lines))
            times[key] = now
            logger.info(f'Telegram {kind} alert sent for @{self.user}.')
        except Exception as e:
            logger.warning(f'Could not send {kind} alert: {type(e).__name__}')

    def _monitor_check_failed(self, stage, error):
        self._monitor_failures = getattr(self, '_monitor_failures', 0) + 1
        logger.warning(
            f'Monitoring @{self.user}: {stage} failed '
            f'({type(error).__name__}), consecutive={self._monitor_failures}'
        )
        if self._monitor_failures >= 3:
            self._monitor_alert_raised = True
            self._tiktok_alert(
                'monitoring',
                f'{type(error).__name__}: {error}',
                stage=stage,
            )

    def _monitor_check_ok(self):
        if getattr(self, '_monitor_alert_raised', False):
            self._tiktok_alert('recovered', 'Monitor API requests succeeded')
        self._monitor_alert_raised = False
        self._monitor_failures = 0

    def _tiktok_live_ended_after_stream_error(self, user, room_id):
        """Confirm this LIVE has really ended before claiming an interruption.

        The CDN stream can expire immediately when the broadcast finishes,
        while /webcast/room/check_alive briefly retains its previous state.
        Prefer the fresh, public user/room status (2/3 active, 4 ended),
        which was previously verified on the original NAS.
        Do not suppress a real error if we cannot confirm the end.
        """
        import time as _time

        for attempt in range(3):
            try:
                response = self.tiktok.http_client.get(
                    self.tiktok.API_URL,
                    params={
                        'aid': '1988',
                        'sourceType': '54',
                        'uniqueId': user,
                        'user_is_login': 'true',
                    },
                    timeout=12,
                )
                response.raise_for_status()
                payload = response.json()
                if isinstance(payload, dict) and str(payload.get('statusCode')) == '0':
                    data = payload.get('data') or {}
                    live_room = data.get('liveRoom') or {}
                    status = str(live_room.get('status'))
                    observed_room = str((data.get('user') or {}).get('roomId') or '')
                    if status == '4':
                        logger.info(
                            f'@{user}: LIVE confirmed ended (native status=4); '
                            'do not send interruption alert.'
                        )
                        return True
                    if observed_room and observed_room != str(room_id):
                        logger.info(
                            f'@{user}: stream belongs to previous Room ID; '
                            'do not send interruption alert.'
                        )
                        return True
                    if status in ('2', '3'):
                        logger.info(
                            f'@{user}: LIVE still active; checking again '
                            f'({attempt + 1}/3).'
                        )
            except Exception as error:
                logger.warning(
                    f'@{user}: cannot verify LIVE end: {type(error).__name__}'
                )
            if attempt < 2:
                _time.sleep(2)

        # No reliable confirmation that LIVE ended. Preserve the alert.
        return False

    def _setup(self):
        """Resolve user/room data and validate prerequisites via network calls."""
        if self.mode == Mode.FOLLOWERS:
            self.check_country_blacklisted()

            self.sec_uid = self.tiktok.get_sec_uid()
            if self.sec_uid is None:
                raise TikTokRecorderError("Failed to retrieve sec_uid.")

            logger.info("Followers mode activated\n")
        else:
            if self.url:
                self.user, self.room_id = self.tiktok.get_room_and_user_from_url(
                    self.url
                )

            if not self.user:
                self.user = self.tiktok.get_user_from_room_id(self.room_id)

            if not self.room_id:
                self.room_id = self.tiktok.get_room_id_from_user(self.user)

            self.check_country_blacklisted()

            logger.info(f"USERNAME: {self.user}" + ("\n" if not self.room_id else ""))
            if self.room_id:
                logger.info(
                    f"ROOM_ID:  {self.room_id}"
                    + ("\n" if not self.tiktok.is_room_alive(self.room_id) else "")
                )

        # If proxy was used for the initial checks, switch to a direct connection
        # for the actual stream download to avoid proxy bottlenecks
        if self._proxy:
            self.tiktok = TikTokAPI(proxy=None, cookies=self._cookies)

    def run(self):
        """Retry startup checks instead of silently exiting during an API outage."""
        if self.mode == Mode.AUTOMATIC:
            while True:
                try:
                    self._setup()
                    self._monitor_check_ok()
                    break
                except (KeyboardInterrupt, SystemExit):
                    raise
                except Exception as error:
                    self._monitor_check_failed('startup', error)
                    time.sleep(60)
            self.automatic_mode()
            return

        self._setup()
        if self.mode == Mode.MANUAL:
            self.manual_mode()
        elif self.mode == Mode.FOLLOWERS:
            self.followers_mode()

    def manual_mode(self):
        if not self.tiktok.is_room_alive(self.room_id):
            raise UserLiveError(f"@{self.user}: {TikTokError.USER_NOT_CURRENTLY_LIVE}")

        self.start_recording(self.user, self.room_id)

    def automatic_mode(self):
        """Monitor independently of streaming, with actionable alert classes."""
        while True:
            stage = 'room_id_lookup'
            try:
                self.room_id = self.tiktok.get_room_id_from_user(self.user)
                if not self.room_id:
                    raise RuntimeError('Room ID unavailable')

                stage = 'live_status_check'
                alive = self.tiktok.is_room_alive(self.room_id)
                self._monitor_check_ok()

            except (UserLiveError, LiveNotFound) as error:
                if str(TikTokError.USER_NOT_CURRENTLY_LIVE) in str(error):
                    self._monitor_check_ok()
                else:
                    self._monitor_check_failed(stage, error)
                logger.info(
                    f'Waiting {self.automatic_interval} minutes before recheck'
                )
                time.sleep(self.automatic_interval * TimeOut.ONE_MINUTE)
                continue

            except Exception as error:
                self._monitor_check_failed(stage, error)
                time.sleep(TimeOut.CONNECTION_CLOSED * TimeOut.ONE_MINUTE)
                continue

            if not alive:
                logger.info(f'@{self.user}: {TikTokError.USER_NOT_CURRENTLY_LIVE}')
                logger.info(
                    f'Waiting {self.automatic_interval} minutes before recheck'
                )
                time.sleep(self.automatic_interval * TimeOut.ONE_MINUTE)
                continue

            # Reaching this point means the LIVE was confirmed, not merely
            # that a monitor request failed.
            self._recording_bytes = 0
            self._recording_phase = 'starting'
            self._stream_retry_failures = 0
            try:
                self.start_recording(self.user, self.room_id)
            except (KeyboardInterrupt, SystemExit):
                raise
            except Exception as error:
                interrupted = (
                    self._recording_bytes >= 4096
                    and self._recording_phase == 'recording'
                )
                self._tiktok_alert(
                    'interrupted' if interrupted else 'failed',
                    f'{type(error).__name__}: {error}',
                    stage=self._recording_phase,
                )
                logger.error(
                    f'Recording @{self.user} failed: {type(error).__name__}',
                    exc_info=True,
                )
                time.sleep(self.automatic_interval * TimeOut.ONE_MINUTE)

    def followers_mode(self):
        active_recordings = {}  # follower -> Thread

        while True:
            try:
                followers = self.tiktok.get_followers_list(self.sec_uid)

                for follower in followers:
                    if follower in active_recordings:
                        if not active_recordings[follower].is_alive():
                            logger.info(f"Recording of @{follower} finished.")
                            del active_recordings[follower]
                        else:
                            continue

                    try:
                        room_id = self.tiktok.get_room_id_from_user(follower)

                        if not room_id or not self.tiktok.is_room_alive(room_id):
                            continue

                        logger.info(f"@{follower} is live. Starting recording...")

                        thread = Thread(
                            target=self.start_recording,
                            args=(follower, room_id),
                            daemon=True,
                        )
                        thread.start()
                        active_recordings[follower] = thread

                        time.sleep(2.5)

                    except TikTokRecorderError as e:
                        logger.error(f"Error while processing @{follower}: {e}")
                        continue

                    except Exception as e:
                        logger.error(
                            f"Unexpected error processing @{follower}: {e}",
                            exc_info=True,
                        )
                        continue

                print()
                logger.info(
                    f"Waiting {self.automatic_interval} minutes for the next check..."
                )
                time.sleep(self.automatic_interval * TimeOut.ONE_MINUTE)

            except (UserLiveError, LiveNotFound) as ex:
                logger.info(ex)
                logger.info(
                    f"Waiting {self.automatic_interval} minutes before recheck\n"
                )
                time.sleep(self.automatic_interval * TimeOut.ONE_MINUTE)

            except (ConnectionError, RequestException, HTTPException):
                logger.error(Error.CONNECTION_CLOSED_AUTOMATIC)
                time.sleep(TimeOut.CONNECTION_CLOSED * TimeOut.ONE_MINUTE)

    def _build_output_path(
        self,
        user: str,
        protocol: str = "flv",
        timestamp: str | None = None,
    ) -> str:
        timestamp = timestamp or time.strftime("%Y.%m.%d_%H-%M-%S", time.localtime())
        suffix = "_hls.ts" if protocol == "hls" else "_flv.mp4"
        filename = f"TK_{user}_{timestamp}{suffix}"
        if self.output:
            return str(Path(self.output) / filename)
        return filename

    def _download_stream(self, live_url: str, protocol: str):
        if protocol == "hls":
            return VideoManagement.download_hls_stream(
                live_url,
                duration=self.duration,
                ffmpeg_path=self.ffmpeg_path,
                headers=self.tiktok.get_stream_headers(),
            )
        return self.tiktok.download_flv_stream(live_url)

    def start_recording(self, user, room_id):
        """
        Start recording live
        """
        live_urls = self.tiktok.get_live_url_candidates(room_id, user=user)
        if not live_urls:
            raise LiveNotFound(TikTokError.RETRIEVE_LIVE_URL)

        min_stream_bytes = 4096
        recording_timestamp = time.strftime("%Y.%m.%d_%H-%M-%S", time.localtime())
        output = None
        telegram_start_notified = False

        for index, live_url in enumerate(live_urls, start=1):
            protocol = "hls" if self.tiktok.is_hls_url(live_url) else "flv"
            output = self._build_output_path(
                user,
                protocol=protocol,
                timestamp=recording_timestamp,
            )
            Path(output).unlink(missing_ok=True)

            if self.duration:
                logger.info(
                    f"Started recording for {self.duration} seconds "
                    f"(stream {index}/{len(live_urls)}, {protocol.upper()})"
                )
            else:
                logger.info(
                    f"Started recording (stream {index}/{len(live_urls)}, "
                    f"{protocol.upper()})..."
                )

            buffer_size = 512 * 1024  # 512 KB buffer
            buffer = bytearray()
            bytes_written = 0

            logger.info("[PRESS CTRL + C ONCE TO STOP]")
            with open(output, "wb") as out_file:
                stop_recording = False
                stream_ended = False
                while not stop_recording and not self.stopping():
                    try:
                        if not self.tiktok.is_room_alive(room_id):
                            logger.info("User is no longer live. Stopping recording.")
                            break

                        start_time = time.time()
                        stream = self._download_stream(live_url, protocol)
                        try:
                            for chunk in stream:
                                if self.stopping():
                                    stop_recording = True
                                    break
                                buffer.extend(chunk)
                                bytes_written += len(chunk)
                                self._recording_bytes = bytes_written
                                self._stream_retry_failures = 0
                                if bytes_written >= min_stream_bytes:
                                    self._recording_phase = 'recording'
                                if (self.use_telegram and not telegram_start_notified and bytes_written > 0):
                                    Telegram().send_message("🔴 <b>TikTok LIVE detected</b>\n\n" + f"👤 @{user}\n" + "🎬 Recording started")
                                    telegram_start_notified = True
                                if len(buffer) >= buffer_size:
                                    out_file.write(buffer)
                                    buffer.clear()

                                elapsed_time = time.time() - start_time
                                if self.duration and elapsed_time >= self.duration:
                                    stop_recording = True
                                    break
                            else:
                                stream_ended = True
                        finally:
                            close_stream = getattr(stream, "close", None)
                            if close_stream:
                                close_stream()

                        if stream_ended and bytes_written < min_stream_bytes:
                            break
                        if stream_ended and bytes_written >= min_stream_bytes:
                            if self._tiktok_live_ended_after_stream_error(user, room_id):
                                logger.info('Stream EOF after LIVE ended: finalize recording.')
                                break
                    except ConnectionError as ex:
                        self._stream_retry_failures += 1
                        logger.warning(
                            f'Stream connection error ({self._stream_retry_failures}/3): '
                            f'{type(ex).__name__}'
                        )
                        if self._stream_retry_failures >= 3:
                            if bytes_written >= min_stream_bytes:
                                if self._tiktok_live_ended_after_stream_error(user, room_id):
                                    logger.info('Stream retries stopped after confirmed LIVE end.')
                                else:
                                    self._tiktok_alert(
                                        'interrupted',
                                        'Stream disconnected repeatedly',
                                        stage='downloading_flv',
                                    )
                            stop_recording = True
                        else:
                            time.sleep(10)

                    except (RequestException, HTTPException) as ex:
                        self._stream_retry_failures += 1
                        logger.warning(
                            f'Stream HTTP error ({self._stream_retry_failures}/3): '
                            f'{type(ex).__name__}'
                        )
                        if self._stream_retry_failures >= 3:
                            if bytes_written >= min_stream_bytes:
                                if self._tiktok_live_ended_after_stream_error(user, room_id):
                                    logger.info('Stream retries stopped after confirmed LIVE end.')
                                else:
                                    self._tiktok_alert(
                                        'interrupted',
                                        'Stream HTTP requests failed repeatedly',
                                        stage='downloading_flv',
                                    )
                            stop_recording = True
                        else:
                            time.sleep(2)

                    except KeyboardInterrupt:
                        logger.info("Recording stopped by user.")
                        stop_recording = True

                    except Exception as ex:
                        logger.error(
                            f'Unexpected error during recording: {ex}',
                            exc_info=True,
                        )
                        if bytes_written >= min_stream_bytes:
                            self._tiktok_alert(
                                'interrupted',
                                f'{type(ex).__name__}: {ex}',
                                stage='downloading_flv',
                            )
                        # If no viable bytes were ever received, try the
                        # next CDN candidate; if all fail automatic_mode
                        # will report Recording failed.
                        stop_recording = True

                    finally:
                        if buffer:
                            out_file.write(buffer)
                            buffer.clear()
                        out_file.flush()

            if bytes_written >= min_stream_bytes:
                break

            logger.warning(
                f"Stream {index}/{len(live_urls)} returned only {bytes_written} bytes. "
                "Trying another CDN/quality..."
            )
            Path(output).unlink(missing_ok=True)
        else:
            raise LiveNotFound(TikTokError.RETRIEVE_LIVE_URL)
        self._recording_phase = 'postprocessing'
        logger.info(f"Recording finished: {Path(output).resolve()}\n")
        self.finalize(output)

    def check_country_blacklisted(self):
        is_blacklisted = self.tiktok.is_country_blacklisted()
        if not is_blacklisted:
            return False

        if self.room_id is None:
            raise TikTokRecorderError(TikTokError.COUNTRY_BLACKLISTED)

        if self.mode == Mode.AUTOMATIC:
            raise TikTokRecorderError(TikTokError.COUNTRY_BLACKLISTED_AUTO_MODE)

        elif self.mode == Mode.FOLLOWERS:
            raise TikTokRecorderError(TikTokError.COUNTRY_BLACKLISTED_FOLLOWERS_MODE)

        return is_blacklisted
