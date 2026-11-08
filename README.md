# Stillmate, hosted version

A chess game your calm plays for you. This folder is the whole game as static files: it runs on any web host that
serves HTTPS, with no server of its own. Moves come from Stockfish running inside the browser. Sessions save in
the browser that played them, and nothing is uploaded anywhere.

Built by `tools/build_stillmate.py` from the 5Head Coach App sources. Rebuild it after any change to the game.

## Open it on your own machine

From inside this folder:

```
python -m http.server 8000
```

Then open http://localhost:8000/ in Chrome or Edge. Those two browsers can connect the headband and the chest
strap (Web Bluetooth); Firefox and Safari cannot. Opening the html file straight from disk does not work: the
engine and the Bluetooth need a web address, and localhost counts.

## Put it on GitHub Pages

1. Make a new repository on GitHub (private is fine for Pages on a paid plan; public otherwise).
2. Upload the contents of this folder to the repository root (drag the files onto the "Add file, Upload files" page,
   or push them with git). Keep the folder layout as it is: the page finds its parts by relative paths.
3. In the repository: Settings, Pages, "Deploy from a branch", branch `main`, folder `/ (root)`, Save.
4. After a minute or two, open `https://<your name>.github.io/<repository>/`. The game is at that address.

The `.nojekyll` file in this folder matters: without it, GitHub skips some of the chessboard's files.

## Put it on Netlify

Go to https://app.netlify.com/drop and drag this whole folder onto the page. Netlify gives a `https://...netlify.app`
address straight away. No account settings are needed for the game to run.

## What differs from the game on Kit's laptop

- The laptop version plays the twelve measured bots (Maia-3 and Leela) through the coach server. This version has
  no server, so Stockfish's strength limiter plays each shade at the shade's measured rating (1320 to 3190), and
  purple's shades above that are the unthrottled engine at rising node counts. The page says so in its first line
  and in each game's review.
- The opponent is Stockfish at your rating in both versions.
- Sessions save in the browser only here; the laptop version also writes each session to a folder on the laptop.
- The in-browser engine is single-threaded. A move's work finishes within a few seconds.

## A live demo with the measured bots

For a demo where the real bots matter, run the game from Kit's laptop instead of this folder. The laptop serves the
page and the coach server, and the page looks for the server at `127.0.0.1:5318`, so the simplest live demo is the
laptop itself on a screen or a screen share. A tunnel (for example Cloudflare Tunnel, `cloudflared tunnel --url
http://localhost:5317`) gives the page a public address, but a visitor's browser would then look for the server on
their own machine and fall back to the in-browser engine; a remote demo with the bots needs a second tunnel for port
5318 and the server address in `js/stillmate.js` changed to it.
