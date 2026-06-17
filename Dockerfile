# Commander Keen 4/5/6 launcher — static site served by nginx.
# At container start, the entrypoint scans a mounted /data dir for Keen game files,
# assembles .jsdos bundles + a manifest, then serves the site (see docker/entrypoint.sh).
FROM nginx:1.27-alpine

ARG VERSION=dev
LABEL org.opencontainers.image.title="keen456" \
      org.opencontainers.image.description="Commander Keen 4/5/6 playable in the browser (js-dos)" \
      org.opencontainers.image.source="https://github.com/awkto/keen456" \
      org.opencontainers.image.version="${VERSION}"

# zip is used by the entrypoint to build .jsdos bundles from mounted data files
RUN apk add --no-cache zip

# static site
COPY index.html /usr/share/nginx/html/index.html
COPY css/  /usr/share/nginx/html/css/
COPY js/   /usr/share/nginx/html/js/
COPY games/ /usr/share/nginx/html/games/

COPY docker/default.conf /etc/nginx/conf.d/default.conf
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 80
ENTRYPOINT ["/entrypoint.sh"]
