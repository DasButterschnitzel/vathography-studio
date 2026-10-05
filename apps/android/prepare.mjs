#!/usr/bin/env node
// Prepares the Android project: copies the web app into www/, creates android/
// with Capacitor (not committed), then applies the icons, version and signing.
// Afterwards: `cd android && ./gradlew assembleRelease` (Android SDK and JDK 21 needed).
//
// Env: VERSION_NAME, VERSION_CODE; release signing with ANDROID_KEYSTORE (path),
// ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS, ANDROID_KEY_PASSWORD. Without them the
// APK is signed with the public test key in this folder (fine for sideloading, and
// updates install over each other, but anyone could sign with it).
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AND = path.join(HERE, 'android');
const run = (cmd) => execSync(cmd, { cwd: HERE, stdio: 'inherit' });
const edit = (file, fn) => { const p = path.join(AND, file); fs.writeFileSync(p, fn(fs.readFileSync(p, 'utf8'))); };

run(`node ${JSON.stringify(path.join(HERE, '..', 'copy-web.mjs'))} www`);
if (!fs.existsSync(AND)) run('npx cap add android');
run('npx cap sync android');

fs.cpSync(path.join(HERE, 'res'), path.join(AND, 'app/src/main/res'), { recursive: true });
fs.rmSync(path.join(AND, 'app/src/main/res/drawable-v24/ic_launcher_foreground.xml'), { force: true });
edit('app/src/main/res/values/ic_launcher_background.xml', (s) => s.replace(/#[0-9A-Fa-f]{6}/, '#0B0B0C'));

// Documents/Vathography needs the storage permission on Android 10 and older
edit('app/src/main/AndroidManifest.xml', (s) => s.includes('WRITE_EXTERNAL_STORAGE') ? s : s.replace('<uses-permission android:name="android.permission.INTERNET" />',
  '<uses-permission android:name="android.permission.INTERNET" />\n    <uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="29" />\n    <uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="29" />'));

const pkg = JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8'));
const versionName = process.env.VERSION_NAME || pkg.version;
const versionCode = +process.env.VERSION_CODE || 1;
edit('app/build.gradle', (s) => {
  s = s.replace(/versionCode \d+/, `versionCode ${versionCode}`).replace(/versionName "[^"]*"/, `versionName "${versionName}"`);
  if (s.includes('// vathography signing')) return s;
  return s + `
// vathography signing
android {
    signingConfigs {
        release {
            storeFile file(System.getenv('ANDROID_KEYSTORE') ?: '../../test.keystore')
            storePassword System.getenv('ANDROID_KEYSTORE_PASSWORD') ?: 'vathography'
            keyAlias System.getenv('ANDROID_KEY_ALIAS') ?: 'vathography'
            keyPassword System.getenv('ANDROID_KEY_PASSWORD') ?: (System.getenv('ANDROID_KEYSTORE_PASSWORD') ?: 'vathography')
        }
    }
    buildTypes { release { signingConfig signingConfigs.release } }
}
`;
});
console.log(`android/ ready (version ${versionName}, code ${versionCode})`);
