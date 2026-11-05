SPACEARCADES SHARED JSON SAVE - SETUP
====================================

WHAT THIS DOES
- Keeps your existing SpaceArcades HTML/design.
- Saves custom games, deleted-game IDs, restore backups, and thumbnail data in one shared JSON object in Vercel Blob.
- All visitors load the same shared catalogue from /api/state.
- Admin can add games. Co-owner and owner can add/remove/restore using the existing panel.
- The API checks role codes on the server before accepting writes.

IMPORTANT LIMITATIONS
- The current frontend's permanent-delete control is not implemented by this integration; this build supports remove-to-recycle-bin and restore.
- Thumbnails are currently stored as data URLs inside the JSON object. Keep images small; the API rejects state larger than 4 MB. A separate Blob image-upload route is the next improvement if you need many large thumbnails.
- This uses Vercel Blob as persistent shared storage. A normal GitHub Pages deployment cannot run /api/state; the API must be served by Vercel. Your normal website link should point/redirect to the Vercel deployment if it must share the same data.
- Existing games hard-coded into the original HTML remain there. This API syncs custom games, deletions, restoration data, and uploaded thumbnail overrides. It does not rewrite the HTML or GitHub files.
- Simultaneous writes from multiple admins can overwrite one another; avoid editing at exactly the same time.

DEPLOY
1. Put index.html, api/state.js, package.json, and vercel.json in the root of the GitHub repository.
2. In Vercel, import/connect that GitHub repository.
3. In Vercel Storage, create/connect a Blob store to this project. This supplies BLOB_READ_WRITE_TOKEN.
4. In Vercel Project Settings > Environment Variables, add:
   SPACEARCADES_ADMIN_CODE = your admin code
   SPACEARCADES_COOWNER_CODE = your co-owner code
   SPACEARCADES_OWNER_CODE = your owner code
   Use the same codes currently used by your website (070814, 0708, 1605) if you have not changed them.
5. Redeploy the project after adding the variables and Blob store.
6. Open the Vercel deployment URL, enter a role code, and add a test game. Open the site in another browser/device to verify it appears there.

SECURITY NOTE
The current HTML still contains the role-code checks for showing panels. The API also checks the codes server-side, but the role codes in the old HTML are visible to visitors. For stronger security, replace the frontend keycode check with a server-issued session token in a later security pass. Do not treat this as production-grade authentication until that is done.
