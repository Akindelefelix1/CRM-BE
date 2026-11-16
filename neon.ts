import { defineConfig } from '@neon/config/v1';

export default defineConfig({
  auth: true,
  buckets: {
    uploads: {}, // Private by default; access files through short-lived signed URLs.
  },
});
