FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000 DATA_DIR=/app/data NODE_NO_WARNINGS=1
COPY server.js story.json ./
COPY public ./public
EXPOSE 3000
CMD ["node", "server.js"]
