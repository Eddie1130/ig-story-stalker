const INSTAGRAM_HOST_RE = /(^|\.)instagram\.com$/i;

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

function parseForm(body = '') {
  try {
    return new URLSearchParams(body);
  } catch {
    return new URLSearchParams();
  }
}

function extractFriendlyName(body = '') {
  const p = parseForm(body);
  return (
    p.get('fb_api_req_friendly_name') ||
    p.get('friendly_name') ||
    p.get('operationName') ||
    ''
  );
}

function hasReadReceiptMarker(text = '') {
  const t = `${text}\n${safeDecode(text)}`;
  return (
    /PolarisStoriesV3SeenMutation/i.test(t) ||
    /\bSeenMutation\b/i.test(t) ||
    /MarkThreadAsRead/i.test(t)
  );
}

function matchesGraphqlRule(body, rule) {
  const p = parseForm(body);
  const friendlyName = p.get('fb_api_req_friendly_name') || '';
  const docId = p.get('doc_id') || '';

  if (friendlyName !== rule.friendlyName) return false;
  if (String(docId) !== String(rule.docId)) return false;

  let variables;
  try {
    variables = JSON.parse(p.get('variables') || '{}');
  } catch {
    return false;
  }

  // Exact expected shape for the read-only standalone Story query.
  const keys = Object.keys(variables).sort();
  const allowedKeys = [
    '__relay_internal__pv__PolarisCommunityNoteStoriesLabelEnabledrelayprovider',
    'reel_ids_arr',
  ].sort();

  if (JSON.stringify(keys) !== JSON.stringify(allowedKeys)) return false;

  if (
    !Array.isArray(variables.reel_ids_arr) ||
    variables.reel_ids_arr.length !== 1 ||
    String(variables.reel_ids_arr[0]) !== String(rule.targetUserId)
  ) {
    return false;
  }

  if (
    variables.__relay_internal__pv__PolarisCommunityNoteStoriesLabelEnabledrelayprovider !== true
  ) {
    return false;
  }

  return true;
}

export async function installNetworkGuard(
  context,
  log,
  {
    mode = 'runtime',
    allowedGraphqlQueries = [],
    allowedGraphqlRules = [],
    blockSubresources = false,
  } = {},
) {
  const simpleAllow = new Set(allowedGraphqlQueries);

  const stats = {
    allowed: 0,
    allowedGraphql: 0,
    blockedReadReceipt: 0,
    blockedUnknownPost: 0,
    blockedRuleMismatch: 0,
    blockedSubresource: 0,
  };

  await context.route('**/*', async (route) => {
    const req = route.request();
    const method = req.method().toUpperCase();
    const url = req.url();

    let parsedUrl;
    let host = '';
    try {
      parsedUrl = new URL(url);
      host = parsedUrl.hostname;
    } catch {}

    const isInstagram = INSTAGRAM_HOST_RE.test(host);
    const body = req.postData() || '';
    const friendlyName = extractFriendlyName(body);

    if (
      blockSubresources &&
      ['image', 'media', 'font', 'stylesheet', 'script'].includes(req.resourceType())
    ) {
      stats.blockedSubresource++;
      await route.abort('blockedbyclient');
      return;
    }

    if (!isInstagram) {
      stats.allowed++;
      await route.continue();
      return;
    }

    if (hasReadReceiptMarker(`${friendlyName}\n${body}`)) {
      stats.blockedReadReceipt++;
      log('CRITICAL_BLOCKED_READ_RECEIPT', {
        method,
        url,
        resourceType: req.resourceType(),
        operation: friendlyName || '(unknown)',
      });
      await route.abort('blockedbyclient');
      return;
    }

    if (mode === 'login') {
      stats.allowed++;
      await route.continue();
      return;
    }

    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      const isGraphql = parsedUrl && /\/graphql\/query\/?$/i.test(parsedUrl.pathname);

      if (isGraphql) {
        const matchedExactRule = allowedGraphqlRules.some(rule =>
          matchesGraphqlRule(body, rule)
        );

        if (matchedExactRule) {
          stats.allowed++;
          stats.allowedGraphql++;
          log('ALLOW_GRAPHQL_EXACT', {
            method,
            operation: friendlyName,
            url,
          });
          await route.continue();
          return;
        }

        if (friendlyName && simpleAllow.has(friendlyName)) {
          stats.allowed++;
          stats.allowedGraphql++;
          log('ALLOW_GRAPHQL_SIMPLE', {
            method,
            operation: friendlyName,
            url,
          });
          await route.continue();
          return;
        }

        if (friendlyName) stats.blockedRuleMismatch++;
      }

      stats.blockedUnknownPost++;
      log('BLOCK_UNKNOWN_INSTAGRAM_WRITE', {
        method,
        operation: friendlyName || '(unknown)',
        url,
      });
      await route.abort('blockedbyclient');
      return;
    }

    stats.allowed++;
    await route.continue();
  });

  return stats;
}
