/** `react-native` as far as the modules under test look at it: which platform. */
export const Platform = { OS: 'android' as const, select: <T>(spec: { android?: T; default?: T }) => spec.android ?? spec.default };
