# Repository workflow

- Repository: https://github.com/likedrift/SITranslate (origin).
- The user authorizes committing and pushing each completed update. Run checks appropriate to the change, commit the intended source and documentation, then push to origin. Report the commit and any actual push blocker.
- Preserve unrelated work and remote history. Do not force push.
- Never commit API keys, credentials, browser profiles, dependencies, generated builds, or local test artifacts. Keep these covered by .gitignore.
- Keep translation requests user-triggered. Selection alone must not send text to a model.
- Keep the page script lightweight and preserve page behavior and explicit user settings.
- Automated audio verification must be inaudible. Keep the isolated test browser muted; never remove its mute flag, play audible tones, or change the user's system volume or everyday browser audio. If real nonzero capture cannot be verified silently, use offline signal tests and report that limitation instead of enabling sound.
- Communicate with the user in concise Chinese.
