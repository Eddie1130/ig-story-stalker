"""Offline compatibility checks; run inside the TikTok worker image only."""
from types import SimpleNamespace
from unittest.mock import Mock, patch
from core.tiktok_api import TikTokAPI
from core.tiktok_recorder import TikTokRecorder
from utils.custom_exceptions import UserLiveError

api = TikTokAPI(proxy=None, cookies={})
api.http_client = Mock()
api.http_client.get.return_value.json.return_value = {'data': {}}
try:
    api.is_room_alive('123')
    raise AssertionError('malformed live status treated as offline')
except RuntimeError:
    pass
api.http_client.get.return_value.json.return_value = {'data': [{'alive': False}]}
assert api.is_room_alive('123') is False
api.http_client.get.return_value.json.return_value = {'statusCode': 0, 'data': {'user': {'roomId': '0'}}}
try:
    api.get_room_id_from_user('alice')
    raise AssertionError('explicit offline response not classified')
except UserLiveError:
    pass
rec = TikTokRecorder.__new__(TikTokRecorder)
rec.tiktok = SimpleNamespace(API_URL='https://example.invalid', http_client=Mock())
rec.tiktok.http_client.get.return_value.json.return_value = {'statusCode': 0, 'data': {'liveRoom': {'status': 4}, 'user': {'roomId': '123'}}}
assert rec._tiktok_live_ended_after_stream_error('alice', '123') is True
rec.tiktok.http_client.get.side_effect = RuntimeError('unavailable')
with patch('time.sleep'):
    assert rec._tiktok_live_ended_after_stream_error('alice', '123') is False
print('TikTok runtime compatibility, offline/error distinction, normal LIVE end checks passed')
