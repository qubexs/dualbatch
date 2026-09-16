// All DOM queries live here so fragile site markup is easy to fix.
// Prefer role/text queries over obfuscated class names.

export const META_SELECTORS = {
  editor: [
    'div[contenteditable="true"]',
    'textarea[placeholder*="Ask" i]',
    'textarea',
    '[role="textbox"]'
  ],
  sendButton: [
    'button[aria-label*="Send" i]',
    'button[type="submit"]',
    'button:has(svg)'
  ],
  image: 'img[src*="fbcdn"], img[src*="scontent"], img[src*="meta"]',
  loginWall: 'input[type="password"], a[href*="login"]'
};

export const FLOW_SELECTORS = {
  promptBox: ['textarea', 'div[contenteditable="true"]', '[role="textbox"]'],
  // Flow prompt container observed in the wild (flow.google.com/project/...):
  // "backdrop-blur-elevation-01 bg-fill-blur-thick shadow-blur-elevation-01 rounded-32 ... cursor-text ..."
  // Match on the two most distinctive tokens; full-class match would be brittle.
  promptBoxContainer: [".bg-fill-blur-thick.cursor-text", ".backdrop-blur-elevation-01.cursor-text", ".rounded-32.cursor-text"],
  fileInput: 'input[type="file"]',
  // Buttons/menus matched by visible text (see flow.ts textMatch()).
  modelButtonHints: ["Veo", "Omni", "Model"],
  generateHints: ["Generate", "Create", "Submit"],
  loginWall: 'input[type="password"]'
};
