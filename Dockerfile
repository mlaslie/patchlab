# Serves the single-file build (dist/patchlab.html) as a static site on Cloud Run.
# Rebuild it first with: node scripts/bundle.js
FROM nginx:1.27-alpine
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY dist/patchlab.html /usr/share/nginx/html/index.html
EXPOSE 8080
