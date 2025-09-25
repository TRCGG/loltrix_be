-- Migration: Add error_log table for error tracking
-- Created: 2025-09-25

CREATE TABLE IF NOT EXISTS error_log (
    id SERIAL PRIMARY KEY,
    error_code VARCHAR(50) NOT NULL UNIQUE,
    error JSONB NOT NULL,
    request JSONB,
    user_agent VARCHAR(512),
    ip_address VARCHAR(45),
    user_id VARCHAR(255),
    severity VARCHAR(20) NOT NULL DEFAULT 'error',
    status INTEGER NOT NULL DEFAULT 500,
    create_date TIMESTAMP NOT NULL DEFAULT NOW(),
    is_deleted BOOLEAN NOT NULL DEFAULT FALSE
);

-- Create index for efficient error code lookup
CREATE INDEX IF NOT EXISTS idx_error_log_error_code ON error_log(error_code);

-- Create index for date-based queries
CREATE INDEX IF NOT EXISTS idx_error_log_create_date ON error_log(create_date);

-- Create index for severity filtering
CREATE INDEX IF NOT EXISTS idx_error_log_severity ON error_log(severity);

-- Create index for user tracking
CREATE INDEX IF NOT EXISTS idx_error_log_user_id ON error_log(user_id) WHERE user_id IS NOT NULL;