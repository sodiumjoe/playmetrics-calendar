# Chrome Extension in TypeScript - Setup Plan

## Project Structure
```
playmetrics-calendar/
├── src/
│   ├── background.ts
│   ├── content.ts
│   ├── popup.ts
│   └── popup.html
├── dist/ (build output)
├── manifest.json
├── package.json
├── tsconfig.json
├── webpack.config.js
├── .gitignore
└── README.md
```

## Steps

1. Initialize git repository
2. Create .gitignore
3. Initialize npm project
4. Install TypeScript and Chrome extension type definitions
5. Install webpack and loaders for bundling
6. Create manifest.json (Chrome extension configuration)
7. Create tsconfig.json (TypeScript configuration)
8. Create webpack.config.js (build configuration)
9. Create basic extension files:
   - background.ts (service worker)
   - popup.html (popup UI)
   - popup.ts (popup script)
   - content.ts (optional content script)
10. Add build scripts to package.json
11. Create README.md
12. Initial git commit

## Configuration Details

### manifest.json
- Manifest V3 (latest standard)
- Basic permissions
- Service worker for background script
- Popup action

### TypeScript
- Target ES2020
- Module: ESNext
- Chrome types included

### Webpack
- Multiple entry points (background, popup, content)
- TypeScript loader
- Output to dist/

### .gitignore
- node_modules/
- dist/
- *.log

## Build Commands
- `npm run build` - Production build
- `npm run watch` - Development watch mode
