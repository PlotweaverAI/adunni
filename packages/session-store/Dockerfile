FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/session-store/package.json ./packages/session-store/
COPY packages/shared-types/package.json ./packages/shared-types/
RUN npm install --workspace @adunni/session-store --workspace @adunni/shared-types --ignore-scripts
COPY packages/shared-types/ ./packages/shared-types/
RUN npm run build --workspace @adunni/shared-types
COPY packages/session-store/ ./packages/session-store/
RUN npm run build --workspace @adunni/session-store
EXPOSE 3006
CMD ["node", "packages/session-store/dist/server.js"]
