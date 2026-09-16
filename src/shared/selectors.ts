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
  fileInput: 'input[type="file"]',
  // Buttons/menus matched by visible text (see flow.ts textMatch()).
  modelButtonHints: ["Veo", "Omni", "Model"],
  generateHints: ["Generate", "Create", "Submit"],
  loginWall: 'input[type="password"]'
};
