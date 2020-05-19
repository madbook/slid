/**
 * Must be run/installed with the following deno flags
 * 
 * --allow-write=/dev/tty --allow-read=/dev/tty
 *      to allow reading/writing from the tty
 * --allow-run
 *      to allow running `stty size` to get the tty size
 * --allow-env
 *      to allow reading the TERM_PROGRAM env variable
 * --unstable 
 *      exposes Dev.setRaw, which allows reading individual keystrokes from tty
 */

import { parse } from "https://deno.land/std@0.51.0/flags/mod.ts";
import * as bytes from "https://deno.land/std@0.51.0/bytes/mod.ts";

//
// Parse args and exit early if we're just displaying help
//
const args = parse(Deno.args);

if (args.help || args.h) {
  console.log(`\
Usage: ${Deno.args[0]} [OPTIONS]

Tool for interactively selecting input lines.

Options:

Options:
  -h, --help            output help
  -m, --multiline       enable multiple line selection
  -p, --preserve-order  output lines in order of selection
Controls:
  up                    move cursor up
  down                  move cursor down
  q                     quit / cancel
  s, enter              select line
  c                     output selection to stdout and exit
`);
  Deno.exit();
}

//
// Deno handles all input and output as Uint8Arrays, so we need to initialize
// an encoder and decoder to convert between Uint8Array and string
//
const decoder = new TextDecoder();
const encoder = new TextEncoder();

//
// Open /dev/tty so we can write to and read from the tty
//
// This is necessary because this tool it typically meant to sit between
// other command line tools, so neither stdin nor stdout will typically be
// the active tty.
//
// There's a few helper functions here related to getting the tty size and
// moving the cursor around, since Deno doesn't have native bindings for
// those things right now.
//
// This requires running/installing with the --allow-read=/dev/tty --allow-write=/dev/tty flags
const tty = await Deno.open("/dev/tty", { read: true, write: true });

async function writeToTTY(text: string): Promise<void> {
  await tty.write(encoder.encode(text));
}

// Allows us to read from tty one character at a time
// This requires running/installing with the --unstable flag
Deno.setRaw(tty.rid, true);

let ttyRows = 0;
let ttyCols = 0;
await getTtySize();

// Deno doesn't expose a method to get the tty size, so this just runs `stty size`
// once to get it and caches the result.
// This requires running/installing with the --allow-run
async function getTtySize() {
  const sttyProc = Deno.run(
    { cmd: ["stty", "size"], stdin: tty.rid, stdout: "piped" },
  );
  const size: string = decoder.decode(await sttyProc.output());
  const [rows, cols] = size.split("-").map((n) => parseInt(n, 10));
  ttyRows = rows;
  ttyCols = cols;
}

async function resetCursor() {
  const isTerminalApp = Deno.env.get("TERM_PROGRAM") === "Apple_Terminal";
  const ESC = "\u001B[";
  await writeToTTY(isTerminalApp ? "\u001B8" : ESC + "u");
}

async function scrollCursorUp(n = 0): Promise<void> {
  await writeToTTY("\u001B[A".repeat(n));
}

async function scrollCursorDown(n = 0): Promise<void> {
  await writeToTTY("\u001B[B".repeat(n));
}

// This allows running/installing with the --allow-env flag
async function saveCursor() {
  const isTerminalApp = Deno.env.get("TERM_PROGRAM") === "Apple_Terminal";
  const ESC = "\u001B[";
  const SAVE = isTerminalApp ? "\u001B7" : ESC + "s";
  await writeToTTY(SAVE);
}

function getCols(): number {
  return ttyRows;
}

function getRows(): number {
  return ttyRows - 2;
}

//
// Initialize state that is used to track selected lines and selection order,
// and some functions to manipulate that state.
//
const stdInContent = await Deno.readAll(Deno.stdin);
const choices = decoder.decode(stdInContent).trim().split("\n");
const selected = new Set<number>();
const selectionOrder = new Map<number, number>();
let rowOffset = 0;
let cursorIndex = 0;
let selectionNumber = 0;

function isLineUnselectable(line: string): boolean {
  return line === "";
}

async function select() {
  if (isLineUnselectable(choices[cursorIndex])) {
    return;
  }
  if (selected.has(cursorIndex)) {
    selected.delete(cursorIndex);

    if (args["preserve-order"] || args.p) {
      const removed = selectionOrder.get(cursorIndex)!;
      selectionOrder.delete(cursorIndex);

      selectionNumber--;

      for (let [key, val] of selectionOrder) {
        if (val < removed) continue;
        selectionOrder.set(key, val - 1);
      }
    }
  } else {
    selected.add(cursorIndex);
    if (args["preserve-order"] || args.p) {
      selectionOrder.set(cursorIndex, selectionNumber++);
    } else {
      selectionOrder.set(cursorIndex, cursorIndex);
    }
  }
}

async function moveCursor(
  move: number,
  doRecursiveMove = false,
): Promise<void> {
  const nextIndex = cursorIndex + move;
  if (nextIndex < 0 || nextIndex >= choices.length) {
    return;
  }

  if (isLineUnselectable(choices[nextIndex])) {
    if (doRecursiveMove) {
      await moveCursor(move + (move < 0 ? -1 : 1), doRecursiveMove);
      return;
    } else {
      return;
    }
  }

  if (nextIndex === cursorIndex) return;

  const rows = getRows();

  if (move < 0 && nextIndex < rowOffset) {
    rowOffset = nextIndex;
  } else if (move > 0 && nextIndex >= rowOffset + rows) {
    rowOffset = nextIndex - rows + 1;
  }
  cursorIndex = nextIndex;
}

//
// Rendering helpers
//
// https://en.wikipedia.org/wiki/ANSI_escape_code
const Style = {
  reset: "\x1b[0m",
  faint: "\x1b[2m",
  black: "\x1b[30m",
  magenta: "\x1b[35m",
  bgBrightYellow: "\x1b[103m",
  bgBrightMagenta: "\x1b[105m",
};

const styles = {
  length: 0,
  unselected: (text: string): string => text,
  highlightSelected: (text: string): string =>
    Style.bgBrightMagenta + Style.black + text + Style.reset,
  highlighted: (text: string): string =>
    Style.bgBrightYellow + Style.black + text + Style.reset,
  selected: (text: string): string => Style.magenta + text + Style.reset,
  unselectable: (text: string): string => Style.faint + text + Style.reset,
  clear: (text: string): string => text + Style.reset,
};

function formatLine(line: string, index: number): string {
  const i = index + rowOffset;
  const isHighlighted = i === cursorIndex;
  const isSelected = selected.has(i);

  let formatted = line.trimRight();

  let fn = styles.unselected;
  if (isHighlighted && isSelected) {
    fn = styles.highlightSelected;
  } else if (isHighlighted) {
    fn = styles.highlighted;
  } else if (isSelected) {
    fn = styles.selected;
  } else if (isLineUnselectable(formatted)) {
    fn = styles.unselectable;
  }

  if ((args["preserve-order"] || args.p) && isSelected) {
    const order = selectionOrder.get(i);
    line = `(${order}) ${line}`;
  }
  if (!args.hideNumbers) {
    line = `${i}: ${line}`;
  }

  const padding = getCols() - (line.length + styles.length);

  if (padding >= 0) {
    return `${fn(line)}${" ".repeat(padding)}\n`;
  } else {
    return `${styles.clear(fn(line.slice(0, padding)))}\n`;
  }
}

async function writeScreen() {
  await writeToTTY(
    choices.slice(rowOffset, rowOffset + getRows()).map(formatLine).join(""),
  );
}

async function clearScreen() {
  await writeToTTY(
    new Array(Math.min(choices.length, getRows())).fill(" ".repeat(getCols()))
      .join("\n"),
  );
}

//
// Input handling
//
const UP_BYTES = new Uint8Array([27, 91, 65]);
const DOWN_BYTES = new Uint8Array([27, 91, 66]);
const inputBuffer = new Uint8Array(3);

function getInputAction(): string | void {
  switch (inputBuffer[0]) {
    case 3:
      return "quit";
    case 13:
      return "enter";
    case 27: {
      if (bytes.equal(inputBuffer, UP_BYTES)) {
        return "up";
      } else if (bytes.equal(inputBuffer, DOWN_BYTES)) {
        return "down";
      }
    }
    default:
      return decoder.decode(inputBuffer.slice(0, 1));
  }
}

//
// Main
//
await writeScreen();
await scrollCursorUp(choices.length);
await saveCursor();
await scrollCursorDown(choices.length);

while (await tty.read(inputBuffer)) {
  const action = getInputAction();

  if (action) {
    switch (action) {
      case "q":
      case "quit": {
        tty.close();
        Deno.exit();
      }
      case "up": {
        await handleMoveCursor(-1);
        continue;
      }
      case "down": {
        await handleMoveCursor(1);
        continue;
      }
      case "enter": // intended
      case "s": {
        await handleSelect();
        continue;
      }
      case "c": {
        await handleContinue();
        continue;
      }
    }
  }
}

async function handleMoveCursor(move: number): Promise<void> {
  await moveCursor(move, true);
  await resetCursor();
  await writeScreen();
}

async function handleContinue() {
  if (!selected.size) return;
  await finish();
}

async function handleSelect() {
  await select();
  if (args.multiline || args.m) {
    await resetCursor();
    await writeScreen();
  } else {
    await finish();
  }
}

async function finish() {
  await resetCursor();
  await clearScreen();
  await resetCursor();

  const selectedIndices = Array.from(selected);
  selectedIndices.sort((a, b) => {
    return selectionOrder.get(a)! - selectionOrder.get(b)!;
  });
  const lines = selectedIndices.map((i) => choices[i]);
  await Deno.stdout.write(encoder.encode(lines.join("\n")));
  tty.close();
  Deno.exit();
}
