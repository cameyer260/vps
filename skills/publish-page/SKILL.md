---
name: publish-page
description: Use when the owner asks for a visual, prototype, demo, or page to view in a browser—for example, “show me a visual for this,” “publish this,” or “make me a page I can open on my phone.” Create the artifact and publish it as a static page for the owner to review. Do not use for ordinary code changes, local development, or your own previews.
---

# Publish a page

Use this when the owner wants to see a visual, prototype, demo, or page in a browser. Make the artifact, publish it, check it locally, then give the owner its URL.

## Publish

1. Choose a descriptive slug: 1–64 characters matching `[a-z0-9][a-z0-9-]*` (lowercase letters, digits, and hyphens; starts with a letter or digit). It becomes a URL segment.
2. Put the page in `/home/dev/throwaway-pages/<slug>/` (`PUBLISHED_DIR` overrides `/home/dev/throwaway-pages`). Include `index.html` at minimum. Optional CSS, JavaScript, and images belong in the same directory; sibling assets are served from there too.
3. Use static files only: no server-side code, build step, or npm requirement. Relative URLs work because the page is served under `/s/<slug>/`.
4. Check the page locally before telling the owner it is ready. Fix any obvious problems, then share:
   `https://admin.christophermeyer.dev/s/<slug>/`

## What to expect

The URL is behind Cloudflare Access for the owner's account, but this is still a public-facing host: put no secrets in the page. `/s/` lists published pages newest first by directory modification time. The app reads the directory per request, so publishing or changing files needs no restart; deleting the directory unpublishes the page and removes it from the index.

Every HTML document served under the slug — `index.html` and any other `.html` file — is served with a back arrow at the top left that returns to `/s/`, added by the app, not written into the page: don't add one yourself. The page's own content is untouched, and HTML fragments and non-HTML files (scripts, stylesheets, images) are served byte-for-byte.

These pages are throwaway artifacts outside git. They are never committed and can be overwritten or deleted freely. Root entries that are not valid slug directories are ignored.
