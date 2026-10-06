// Renders src/assets/logo.svg into the app icons (icon.png and icon.ico).
// Run with: npm run icons
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const ASSETS = path.join(__dirname, '../src/assets');
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

// An .ico file is a small directory followed by one PNG per size.
function buildIco(images) {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, i) => {
    const entry = 6 + i * 16;
    header.writeUInt8(size >= 256 ? 0 : size, entry); // width (0 means 256)
    header.writeUInt8(size >= 256 ? 0 : size, entry + 1); // height
    header.writeUInt16LE(1, entry + 4); // colour planes
    header.writeUInt16LE(32, entry + 6); // bits per pixel
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map((image) => image.png)]);
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(ASSETS, 'logo.svg'), 'utf8');
  const page = `<body style="margin:0;background:transparent"><img style="display:block;width:100vw;height:100vh" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}"></body>`;
  const win = new BrowserWindow({ show: false, frame: false, transparent: true, width: 512, height: 512, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page));
  await new Promise((resolve) => setTimeout(resolve, 400));
  const master = await win.webContents.capturePage();

  const images = ICO_SIZES.map((size) => ({ size, png: master.resize({ width: size, height: size, quality: 'best' }).toPNG() }));
  fs.writeFileSync(path.join(ASSETS, 'icon.png'), images.at(-1).png);
  fs.writeFileSync(path.join(ASSETS, 'icon.ico'), buildIco(images));
  console.log(`Wrote icon.png and icon.ico (source render ${master.getSize().width}px)`);
  app.exit(0);
});
