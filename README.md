# PlayMetrics Calendar

Chrome extension built with TypeScript.

## Development

Install dependencies:
```bash
npm install
```

Build the extension:
```bash
npm run build
```

Watch mode for development:
```bash
npm run watch
```

## Loading the Extension

1. Build the extension using `npm run build`
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable "Developer mode"
4. Click "Load unpacked"
5. Select the `dist` directory

## Project Structure

```
playmetrics-calendar/
├── src/
│   ├── background.ts    - Service worker
│   ├── content.ts       - Content script
│   ├── popup.ts         - Popup script
│   └── popup.html       - Popup UI
├── dist/                - Build output
├── manifest.json        - Extension configuration
├── package.json
├── tsconfig.json
└── webpack.config.js
```
