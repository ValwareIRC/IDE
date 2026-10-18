# Following the bottom of the conversation, with a finger

`entry.tsx` is a box that keeps growing (a timer ticking, rows added), using
`lib/stickToBottom.ts`; `?which=before` uses the copy from the last commit
(`git show HEAD:src/renderer/src/lib/stickToBottom.ts > old-stickToBottom.ts`).

    esbuild entry.tsx --bundle --format=iife --jsx=automatic --outfile=scroll-test.js --define:process.env.NODE_ENV='"production"'

Open index.html in a headless Chrome with touch emulation on, swipe with
`Input.dispatchTouchEvent` (touchStart, a dozen touchMoves down the screen, touchEnd),
let it grow for a second and a half, and read `#box.scrollTop`: it should stay where the
finger left it. (`Input.synthesizeScrollGesture` does not move the box here; use the
explicit touch events.)
