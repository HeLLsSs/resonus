// Nothing to call from JS: the module installs itself when the app starts,
// and `src/lib/crashLog.ts` reads the file it writes. This file only exists
// so expo-modules-autolinking picks the local module up.
export {};
