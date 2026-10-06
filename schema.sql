-- ============================================
-- ETHIOPIA BETTING DATABASE
-- ============================================

-- USERS
CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY,

    telegram_id VARCHAR(100) UNIQUE,
    name VARCHAR(255),
    username VARCHAR(255),

    phone VARCHAR(50),

    balance NUMERIC(12,2) NOT NULL DEFAULT 0.00,
    bonus_balance NUMERIC(12,2) NOT NULL DEFAULT 0.00,

    is_active BOOLEAN NOT NULL DEFAULT TRUE,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- TRANSACTIONS
CREATE TABLE IF NOT EXISTS transactions (
    id BIGSERIAL PRIMARY KEY,

    user_id BIGINT NOT NULL
        REFERENCES users(id)
        ON DELETE CASCADE,

    type VARCHAR(30) NOT NULL,

    amount NUMERIC(12,2) NOT NULL,

    status VARCHAR(30) NOT NULL DEFAULT 'pending',

    reference VARCHAR(100) UNIQUE,

    description TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- BETS
CREATE TABLE IF NOT EXISTS bets (
    id BIGSERIAL PRIMARY KEY,

    user_id BIGINT NOT NULL
        REFERENCES users(id)
        ON DELETE CASCADE,

    game VARCHAR(50) NOT NULL,

    stake NUMERIC(12,2) NOT NULL,

    potential_win NUMERIC(12,2) NOT NULL DEFAULT 0.00,

    actual_win NUMERIC(12,2) NOT NULL DEFAULT 0.00,

    status VARCHAR(30) NOT NULL DEFAULT 'pending',

    result JSONB,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    settled_at TIMESTAMPTZ
);


-- GAME ROUNDS
CREATE TABLE IF NOT EXISTS game_rounds (
    id BIGSERIAL PRIMARY KEY,

    game VARCHAR(50) NOT NULL,

    round_number VARCHAR(100) NOT NULL UNIQUE,

    status VARCHAR(30) NOT NULL DEFAULT 'open',

    result JSONB,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    closed_at TIMESTAMPTZ
);


-- INDEXES
CREATE INDEX IF NOT EXISTS idx_users_telegram_id
ON users(telegram_id);

CREATE INDEX IF NOT EXISTS idx_transactions_user_id
ON transactions(user_id);

CREATE INDEX IF NOT EXISTS idx_transactions_status
ON transactions(status);

CREATE INDEX IF NOT EXISTS idx_bets_user_id
ON bets(user_id);

CREATE INDEX IF NOT EXISTS idx_bets_game
ON bets(game);

CREATE INDEX IF NOT EXISTS idx_game_rounds_game
ON game_rounds(game);


-- ============================================
-- FIRST SETTINGS
-- ============================================

CREATE TABLE IF NOT EXISTS settings (
    key VARCHAR(100) PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO settings (key, value)
VALUES
    ('signup_bonus', '50'),
    ('minimum_deposit', '51'),
    ('minimum_withdraw', '51')
ON CONFLICT (key) DO NOTHING;
