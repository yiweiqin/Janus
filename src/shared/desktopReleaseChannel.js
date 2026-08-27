export const STABLE_DESKTOP_RELEASE_CHANNEL = 'stable';
export const TEST_DESKTOP_RELEASE_CHANNEL = 'test';

export function desktopReleaseChannel({ appName = '', explicitChannel = process.env.JANUS_DESKTOP_RELEASE_CHANNEL || '' } = {}) {
  const explicit = String(explicitChannel || '').trim().toLowerCase();
  if (explicit === TEST_DESKTOP_RELEASE_CHANNEL) return TEST_DESKTOP_RELEASE_CHANNEL;
  if (explicit === STABLE_DESKTOP_RELEASE_CHANNEL) return STABLE_DESKTOP_RELEASE_CHANNEL;
  return /(?:^|[\s_-])test$/i.test(String(appName || '').trim())
    ? TEST_DESKTOP_RELEASE_CHANNEL
    : STABLE_DESKTOP_RELEASE_CHANNEL;
}

export function desktopReleaseRootUrl(channel = STABLE_DESKTOP_RELEASE_CHANNEL) {
  return channel === TEST_DESKTOP_RELEASE_CHANNEL
    ? 'http://123.207.22.235/janus/test_releases'
    : 'http://123.207.22.235/janus/releases';
}

export function desktopUserDataDirectoryName(channel = STABLE_DESKTOP_RELEASE_CHANNEL) {
  return channel === TEST_DESKTOP_RELEASE_CHANNEL ? '.janus-test' : '.janus';
}
