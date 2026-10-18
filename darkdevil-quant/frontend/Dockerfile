# Build Next.js production image (next start)
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund

FROM node:22-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npx next build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production DJQ_API_UPSTREAM=http://backend:8000
COPY --from=build /app ./
EXPOSE 3000
HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" || exit 1
CMD ["npm", "run", "start", "--", "--hostname", "0.0.0.0"]
