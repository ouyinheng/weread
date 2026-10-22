import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  // Must match android/app/build.gradle applicationId — a mismatch makes
  // `cap sync` regenerate strings.xml with the wrong package_name.
  appId: 'com.weread.app',
  appName: '微信读书',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
  },
}

export default config
