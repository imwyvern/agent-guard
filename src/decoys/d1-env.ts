export function envBody(tokens: string[], database: string, region: string, revision: string): string {
    return [`NODE_ENV=production`, `APP_NAME=internal-console`, `APP_PORT=8080`, `LOG_LEVEL=info`, `DATABASE_URL=postgres://ag_ro:${tokens[0]}@db-internal.invalid:5432/${database}`, `ADMIN_API_TOKEN=${tokens[1]}`, `STRIPE_SECRET_KEY=${tokens[2]}`, `CACHE_HOST=cache.internal.invalid`, `CACHE_PORT=6379`, `MAIL_HOST=mail.internal.invalid`, `MAIL_PORT=2525`, `REGION=${region}`, `REVISION=${revision}`, `FEATURE_AUDIT=true`, `READ_ONLY=true`].join('\n') + '\n';
}
