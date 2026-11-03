# Serves the single-file build and stores each IAP user's lab (see server/server.js).
FROM node:22-alpine
WORKDIR /app
COPY server/server.js server/server.js
COPY dist/patchlab.html dist/patchlab.html
ENV NODE_ENV=production
USER node
EXPOSE 8080
CMD ["node", "server/server.js"]
