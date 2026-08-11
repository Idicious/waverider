# WaveShaper

## Development

```bash
npm install
npm run dev      # vite dev server on :5173
npm run build    # tsc -> dist/
```

## Tests

```bash
npm run test:e2e
```

### Visual snapshots

`e2e/visual.test.ts` compares canvas screenshots against committed PNGs.
Playwright suffixes each file with the platform it was recorded on, so the repo
carries two sets: `*-darwin.png` for local macOS runs and `*-linux.png` for CI.
Each platform reads only its own set — they are never compared against each
other, which is what keeps identical renders from failing on antialiasing
differences between macOS and the CI container.

When a renderer change intentionally alters the output, **both sets need
updating**, or CI will fail on the linux half:

```bash
npm run test:e2e -- --update-snapshots   # darwin, on your machine
npm run test:e2e:linux:update            # linux, via the CI container image
```

`npm run test:e2e:linux` runs the whole suite in the same image CI uses, which
is the quickest way to reproduce a CI-only failure. Both linux scripts need
Docker running. They mount the repo but keep their own `node_modules` inside
the container, so they will not disturb your local install.
