# Gadgets

A gadget is a mini-app that lives inside Prism as a panel you can dock anywhere. Prism builds it for you from a description. You watch and use it; the agent can operate it too.

Examples: a fleet of virtual machines you cycle through while the agent drives one, your Docker containers with live logs, a music player, a database browser, a board made from your TODO comments.

## Making one

1. Open **Gadgets** in the left rail (Ctrl+Shift+D) and press **+**, or use **Agent → New gadget…**.
2. Describe what you want, or pick an idea card.
3. Choose where it is kept: **In this project** (saved with the project, in `.prism/gadgets/`) or **Everywhere** (available in every project).
4. Leave **Let the agent operate it too** on if you want the agent to be able to press the gadget's buttons for you.
5. Press **Build it**. A new session opens; the agent writes the gadget, opens it, looks at it, and fixes what looks off.

## Using one

Click a gadget in the list to open its panel. The top bar of the panel has:

| Control | What it does |
| --- | --- |
| Dot | Green: running. Amber: starting. Red: it hit a problem. |
| **agent can use it** | Hover to see what the agent can do with this gadget. |
| **runs on this PC** | The gadget runs its own program on your computer (not only a page). |
| Wand | Type what should change; the agent edits the gadget. |
| Square | Stop it (and everything it started). |
| Scroll | Activity log. |
| Arrows | Restart it. |
| Folder | Open the gadget's folder. |

If a gadget fails, the panel says so and offers **Fix with Prism**, which hands the error and the log to the agent.

## Talking to the agent about a gadget

- "Start machine 2 and open a browser on it": the agent uses the gadget's own actions.
- "What is on the screen of beta?": the agent can look at the gadget's panel, or ask the gadget for a screenshot.
- A gadget can also send the agent a message (for example a "hand this to the agent" button).

## Good to know

- Changing how a gadget looks does not restart what it is running. Changing its program does, and everything it started is stopped first.
- Closing Prism stops every gadget and everything they started.
- A gadget that needs extra packages gets them by itself the first time (this needs Node.js installed).
- Right-click a gadget in the list to restart, stop, improve or delete it.
