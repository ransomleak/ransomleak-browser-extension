// Shared look of the in-page warnings (password entry, sensitive paste); matches the warning page tokens.
// Inlined into each self-contained content-script bundle.
export const OVERLAY_CSS = `
    :host { all: initial; }
    .wrap { position: fixed; inset: 0; z-index: 2147483647; display: flex; align-items: center; justify-content: center;
      background: rgba(10, 16, 13, .62); font: 15px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    .card { max-width: 440px; margin: 16px; padding: 22px 22px 18px; border-radius: 12px; background: #fff; color: #14201a;
      box-shadow: 0 18px 48px rgba(0,0,0,.35); border-top: 4px solid #b45309; }
    .brand { display: flex; align-items: center; gap: 8px; margin: 0 0 14px; }
    .brand span { font-size: 15px; font-weight: 700; line-height: 1; letter-spacing: -.02em; }
    .brand svg { width: 24px; height: 24px; flex: none; display: block; }
    h2 { margin: 0 0 8px; font-size: 18px; line-height: 1.25; }
    p { margin: 0 0 16px; color: #3b4a42; }
    .actions { display: flex; gap: 10px; flex-wrap: wrap; }
    button { font: inherit; font-weight: 600; cursor: pointer; border-radius: 8px; padding: 9px 16px; }
    .back { background: #1d7a55; color: #fff; border: 0; }
    .cont { background: transparent; color: #3b4a42; border: 1px solid #c9d4ce; }
    .learn { display: block; margin-top: 12px; padding: 2px 0; border: 0; background: none; border-radius: 4px; font-size: 14px; font-weight: 500; color: #1d7a55; text-decoration: underline; text-underline-offset: 3px; }
    button:focus-visible { outline: 2px solid #1d7a55; outline-offset: 2px; }
    @media (prefers-color-scheme: dark) {
      .card { background: #131d18; color: #e8f0eb; } p { color: #b5c6bc; }
      .learn { color: #5fc79a; }
      .back { background: #5fc79a; color: #0d1511; } .cont { color: #b5c6bc; border-color: #2c3f35; }
    }`;
