# Trying the call face without launching Prism

The face (`src/renderer/src/lib/faceEngine.ts`) knows nothing about the app, so it can run
in a plain page:

    esbuild entry.ts --bundle --format=iife --outfile=face-test.js   # node_modules/.pnpm/esbuild@*/.../bin/esbuild
    node serve.cjs 8812        # serves this folder, and build/face at /models/
    open http://127.0.0.1:8812/?file=/models/prism-face.vrm        (&host=small for the circle)

In the page, `face` holds what it reacts to (stage, mic, speech), `view` is the face, and
`talk('/some.wav')` plays a recording through the same analysis the call uses. Stop the
live loop with `cancelAnimationFrame(view.raf); view.raf = 0` and step it by hand with
`view.stepFor(seconds)` to photograph exact states.

`bands.cjs file.wav --shapes` measures a recording the way the call does and prints the
mouth shapes it would make; the mouth's thresholds in faceEngine.ts were set from it with
Kokoro's bf_emma saying each vowel.
