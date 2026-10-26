# Notepad (React Native + Expo)

An offline notepad for Android (and iOS). Built with **Expo SDK 57** (`expo ~57.0.x`, see `package.json`
for the exact versions).

## Run it during development

1. Install Node.js (22.13 or newer; the test suite needs it).
2. In this folder run:
   ```
   npm install
   npx expo start
   ```
3. Open the project on your phone. **Expo Go** only works if your installed Expo Go supports SDK 57
   (https://expo.dev/go). If it does not, use a development build instead (see below).
4. Check types any time with `npm run typecheck`.

## Build an installable Android app (APK)

The project is set up for EAS Build (`eas.json`):

```
npm install -g eas-cli        # once
eas login                     # once
eas build -p android --profile preview      # APK you can install directly (internal distribution)
eas build -p android --profile development  # development client (use with `npx expo start --dev-client`)
eas build -p android --profile production   # store build (app bundle, auto-incremented version code)
```

Before building you can check that the JavaScript bundles with `npx expo export --platform android`.

## Tests

```
npm run typecheck
npm test                 # app logic, including large-note timing checks
npm run test:silent      # regression suite for silent-failure bugs (see test/silent-failures/README.md)
```

The timing checks compare against wall-clock limits, so a heavily loaded computer can make them fail
once; run them again before assuming something broke.

## Features

**Notes, lists and folders**
- Notes, checklists and folders on one dashboard, with search, edit mode and drag-to-reorder
  (or alphabetical order)
- No limit on how much text a note holds
- Option to jump to the end of a note when it opens, plus a "Jump to end" item in the note menu
- Editor toolbar: copy, paste, undo, redo, find in note, word/character count, lock note
- Revisions (earlier versions of a note), with restore
- Deleted items with a trash that empties itself after a time you choose
- Lists: progress as fraction and/or percentage, move checked items to the bottom, and more
- Share a note or list as text

**Security** (Settings > App Security)
- Password lock (stored as a salted hash in the device's secure storage)
- Fingerprint (or Face ID) unlock, switched on or off in settings
- Inactivity timeout: how long you can leave the app before it locks again
- "Forgotten your password?" with a waiting period before the password can be removed
- Hide app content when backgrounded (on Android this also hides the app in the recent-apps
  list and blocks screenshots)
- Individual notes can be locked so they ask for the password again, and their text is stored
  encrypted (see "Security: what is and is not protected" below)

**Themes** (Settings > App Customisation > App Colour Themes)
- Dark / Light switch, plus Dark Mode, Default, Rich Red, Christmas, Halloween, Panda White,
  Cloud White and a Custom theme with your own colours
- Text size (6 steps), fonts, date format, title capitalisation, screen orientation, keep screen
  awake, navigation bar colour

**Import / export / backups** (menu on the home screen, and Settings > Data Management)
- Export everything as a `.json` backup (can be imported again) or as plain `.txt`
- Import a backup (add to current notes, or replace everything) or any text file as a new note
- Scheduled backups: made when you open the app and one is due (daily to monthly), with a log
- Choose the exported file name format

## Notes

- Backups run when the app opens. Expo Go cannot run tasks while the app is closed.
- The code is in `src/`; `App.tsx` wires the providers, lock screen and device settings together.

## Security: what is and is not protected

This is a personal project. It has **not been independently audited**, so do not rely on it alone for
highly sensitive data.

**Protected**
- When you lock a note or list, its text, its list entries and its revision history are stored
  **encrypted** (AES-256-GCM, via `expo-crypto`).
- The encryption key is random and is kept in the phone's secure storage (Android Keystore), not in
  the notes database. A copy of the database file or a device backup holds unreadable text for locked items.
- If the key is missing, the app refuses to open the locked note and does not overwrite it.

**Not protected**
- **Exports and backups are plain text.** Keep exported files somewhere private.
- **Titles of locked notes are not encrypted.** Do not put secrets in a title.
- The app password is checked with a light salted SHA-256 loop (500 rounds). It is not a strong
  password-hashing function, so choose a long password.
- The app password does not generate the encryption key. The lock screen keeps people out of the app;
  the encryption protects the data file. Someone with a rooted phone and the app running could still
  reach the data.
- **If you uninstall the app or move to a new phone, the key is gone** and locked notes cannot be read.
  Keep a backup export of anything important.

## License

Add a license of your choice here (for example MIT) before sharing the code for reuse.
