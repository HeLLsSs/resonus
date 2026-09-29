/** `react-native` as far as the modules under test look at it: which platform. */
export const Platform = { OS: 'android' as const, select: <T>(spec: { android?: T; default?: T }) => spec.android ?? spec.default };

/** `AppState` as the Jam store subscribes to it: nothing ever changes state in a test. */
export const AppState = {
  currentState: 'active' as const,
  addEventListener: (_event: string, _cb: (state: string) => void) => ({ remove: () => {} }),
};

/** `PermissionsAndroid` as ride mode asks it: nothing is ever granted in a test. */
export const PermissionsAndroid = {
  PERMISSIONS: { BLUETOOTH_CONNECT: 'android.permission.BLUETOOTH_CONNECT' },
  RESULTS: { GRANTED: 'granted' },
  request: async (_permission: string) => 'denied',
};
