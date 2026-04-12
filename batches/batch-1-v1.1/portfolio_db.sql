-- ============================================================
-- Portfolio Analyzer Database Schema
-- Self-contained SQLite database for portfolio analysis
-- ============================================================

-- Ticker/Security master table
CREATE TABLE IF NOT EXISTS securities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker TEXT UNIQUE NOT NULL,
    name TEXT,
    sector TEXT,
    industry TEXT,
    exchange TEXT,
    asset_type TEXT DEFAULT 'equity', -- equity, etf, mutual_fund, crypto, bond
    currency TEXT DEFAULT 'USD',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Live/current quote data (cached)
CREATE TABLE IF NOT EXISTS quotes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker TEXT NOT NULL,
    price REAL,
    open_price REAL,
    high REAL,
    low REAL,
    close_price REAL,
    prev_close REAL,
    volume INTEGER,
    avg_volume INTEGER,
    market_cap REAL,
    beta REAL,
    pe_ratio REAL,
    fwd_pe_ratio REAL,
    eps REAL,
    fwd_eps REAL,
    dividend_yield REAL,
    dividend_rate REAL,
    ex_dividend_date TEXT,
    fifty_two_week_high REAL,
    fifty_two_week_low REAL,
    fifty_day_avg REAL,
    two_hundred_day_avg REAL,
    shares_outstanding REAL,
    book_value REAL,
    price_to_book REAL,
    fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (ticker) REFERENCES securities(ticker)
);

-- Greek metrics for options/risk analysis
CREATE TABLE IF NOT EXISTS greeks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker TEXT NOT NULL,
    alpha REAL,        -- Jensen's alpha (excess return vs benchmark)
    beta REAL,         -- Systematic risk measure
    delta REAL,        -- Price sensitivity
    gamma REAL,        -- Rate of change of delta
    sharpe_ratio REAL, -- Risk-adjusted return
    sortino_ratio REAL,
    treynor_ratio REAL,
    r_squared REAL,    -- Correlation with benchmark
    std_dev REAL,      -- Standard deviation of returns
    max_drawdown REAL, -- Maximum peak-to-trough decline
    calc_period TEXT DEFAULT '1Y', -- 1M, 3M, 6M, 1Y, 3Y, 5Y
    calculated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (ticker) REFERENCES securities(ticker)
);

-- Historical price data
CREATE TABLE IF NOT EXISTS price_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker TEXT NOT NULL,
    date TEXT NOT NULL,
    open_price REAL,
    high REAL,
    low REAL,
    close_price REAL,
    adj_close REAL,
    volume INTEGER,
    UNIQUE(ticker, date),
    FOREIGN KEY (ticker) REFERENCES securities(ticker)
);

-- Portfolio definitions
CREATE TABLE IF NOT EXISTS portfolios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    benchmark TEXT DEFAULT 'SPY',
    initial_balance REAL DEFAULT 10000,
    start_date TEXT,
    end_date TEXT,
    rebalance_frequency TEXT DEFAULT 'monthly', -- monthly, quarterly, annually, none
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Portfolio holdings/allocations
CREATE TABLE IF NOT EXISTS portfolio_holdings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    portfolio_id INTEGER NOT NULL,
    ticker TEXT NOT NULL,
    allocation REAL NOT NULL, -- percentage (0-100)
    shares REAL,
    cost_basis REAL,
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (portfolio_id) REFERENCES portfolios(id) ON DELETE CASCADE,
    FOREIGN KEY (ticker) REFERENCES securities(ticker)
);

-- Portfolio performance snapshots
CREATE TABLE IF NOT EXISTS portfolio_performance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    portfolio_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    total_value REAL,
    daily_return REAL,
    cumulative_return REAL,
    drawdown REAL,
    UNIQUE(portfolio_id, date),
    FOREIGN KEY (portfolio_id) REFERENCES portfolios(id) ON DELETE CASCADE
);

-- Portfolio analysis results
CREATE TABLE IF NOT EXISTS analysis_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    portfolio_id INTEGER NOT NULL,
    metric_name TEXT NOT NULL,
    metric_value REAL,
    period TEXT, -- 1M, 3M, 6M, YTD, 1Y, 3Y, 5Y, 10Y, MAX
    calculated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (portfolio_id) REFERENCES portfolios(id) ON DELETE CASCADE
);

-- Correlation matrix storage
CREATE TABLE IF NOT EXISTS correlations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker_a TEXT NOT NULL,
    ticker_b TEXT NOT NULL,
    correlation REAL,
    period TEXT DEFAULT '1Y',
    calculated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(ticker_a, ticker_b, period)
);

-- Watchlist
CREATE TABLE IF NOT EXISTS watchlist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker TEXT NOT NULL UNIQUE,
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    notes TEXT,
    FOREIGN KEY (ticker) REFERENCES securities(ticker)
);

-- Transaction history for backtesting
CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    portfolio_id INTEGER NOT NULL,
    ticker TEXT NOT NULL,
    transaction_type TEXT NOT NULL, -- buy, sell, dividend, rebalance
    shares REAL,
    price REAL,
    total_amount REAL,
    date TEXT NOT NULL,
    FOREIGN KEY (portfolio_id) REFERENCES portfolios(id) ON DELETE CASCADE
);

-- User settings/preferences
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- Indexes for performance
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_quotes_ticker ON quotes(ticker);
CREATE INDEX IF NOT EXISTS idx_quotes_fetched ON quotes(fetched_at);
CREATE INDEX IF NOT EXISTS idx_price_history_ticker ON price_history(ticker, date);
CREATE INDEX IF NOT EXISTS idx_greeks_ticker ON greeks(ticker);
CREATE INDEX IF NOT EXISTS idx_holdings_portfolio ON portfolio_holdings(portfolio_id);
CREATE INDEX IF NOT EXISTS idx_performance_portfolio ON portfolio_performance(portfolio_id, date);
CREATE INDEX IF NOT EXISTS idx_correlations_tickers ON correlations(ticker_a, ticker_b);

-- ============================================================
-- Seed data: Common securities
-- ============================================================
INSERT OR IGNORE INTO securities (ticker, name, sector, industry, exchange, asset_type) VALUES
    ('SPY', 'SPDR S&P 500 ETF Trust', 'Index Fund', 'Large Blend', 'NYSE', 'etf'),
    ('QQQ', 'Invesco QQQ Trust', 'Index Fund', 'Large Growth', 'NASDAQ', 'etf'),
    ('DIA', 'SPDR Dow Jones Industrial Average ETF', 'Index Fund', 'Large Value', 'NYSE', 'etf'),
    ('IWM', 'iShares Russell 2000 ETF', 'Index Fund', 'Small Blend', 'NYSE', 'etf'),
    ('VTI', 'Vanguard Total Stock Market ETF', 'Index Fund', 'Large Blend', 'NYSE', 'etf'),
    ('VOO', 'Vanguard S&P 500 ETF', 'Index Fund', 'Large Blend', 'NYSE', 'etf'),
    ('VXUS', 'Vanguard Total International Stock ETF', 'Index Fund', 'Foreign Large Blend', 'NYSE', 'etf'),
    ('BND', 'Vanguard Total Bond Market ETF', 'Fixed Income', 'Intermediate-Term Bond', 'NYSE', 'etf'),
    ('AGG', 'iShares Core U.S. Aggregate Bond ETF', 'Fixed Income', 'Intermediate-Term Bond', 'NYSE', 'etf'),
    ('GLD', 'SPDR Gold Shares', 'Commodities', 'Precious Metals', 'NYSE', 'etf'),
    ('TLT', 'iShares 20+ Year Treasury Bond ETF', 'Fixed Income', 'Long-Term Bond', 'NYSE', 'etf'),
    ('VNQ', 'Vanguard Real Estate ETF', 'Real Estate', 'Real Estate', 'NYSE', 'etf'),
    ('AAPL', 'Apple Inc.', 'Technology', 'Consumer Electronics', 'NASDAQ', 'equity'),
    ('MSFT', 'Microsoft Corporation', 'Technology', 'Software', 'NASDAQ', 'equity'),
    ('GOOGL', 'Alphabet Inc.', 'Technology', 'Internet Content', 'NASDAQ', 'equity'),
    ('AMZN', 'Amazon.com Inc.', 'Consumer Cyclical', 'Internet Retail', 'NASDAQ', 'equity'),
    ('NVDA', 'NVIDIA Corporation', 'Technology', 'Semiconductors', 'NASDAQ', 'equity'),
    ('META', 'Meta Platforms Inc.', 'Technology', 'Internet Content', 'NASDAQ', 'equity'),
    ('TSLA', 'Tesla Inc.', 'Consumer Cyclical', 'Auto Manufacturers', 'NASDAQ', 'equity'),
    ('BRK-B', 'Berkshire Hathaway Inc.', 'Financial Services', 'Insurance', 'NYSE', 'equity'),
    ('JPM', 'JPMorgan Chase & Co.', 'Financial Services', 'Banks', 'NYSE', 'equity'),
    ('V', 'Visa Inc.', 'Financial Services', 'Credit Services', 'NYSE', 'equity'),
    ('JNJ', 'Johnson & Johnson', 'Healthcare', 'Drug Manufacturers', 'NYSE', 'equity'),
    ('WMT', 'Walmart Inc.', 'Consumer Defensive', 'Discount Stores', 'NYSE', 'equity'),
    ('PG', 'Procter & Gamble Co.', 'Consumer Defensive', 'Household Products', 'NYSE', 'equity'),
    ('XOM', 'Exxon Mobil Corporation', 'Energy', 'Oil & Gas', 'NYSE', 'equity'),
    ('UNH', 'UnitedHealth Group Inc.', 'Healthcare', 'Health Care Plans', 'NYSE', 'equity'),
    ('HD', 'The Home Depot Inc.', 'Consumer Cyclical', 'Home Improvement', 'NYSE', 'equity'),
    ('MA', 'Mastercard Inc.', 'Financial Services', 'Credit Services', 'NYSE', 'equity'),
    ('BAC', 'Bank of America Corp.', 'Financial Services', 'Banks', 'NYSE', 'equity');

-- Default settings
INSERT OR IGNORE INTO settings (key, value) VALUES
    ('theme', 'dark'),
    ('default_benchmark', 'SPY'),
    ('default_period', '1Y'),
    ('cache_duration_minutes', '15'),
    ('risk_free_rate', '0.05'),
    ('default_initial_balance', '10000');

-- Default sample portfolio
INSERT OR IGNORE INTO portfolios (id, name, description, benchmark, initial_balance, start_date) VALUES
    (1, 'Classic 60/40', 'Traditional 60% stocks / 40% bonds allocation', 'SPY', 10000, '2020-01-01'),
    (2, 'Tech Growth', 'Technology-focused growth portfolio', 'QQQ', 10000, '2020-01-01'),
    (3, 'Dividend Income', 'High dividend yield portfolio', 'SPY', 10000, '2020-01-01');

INSERT OR IGNORE INTO portfolio_holdings (portfolio_id, ticker, allocation) VALUES
    (1, 'VOO', 60.0),
    (1, 'BND', 40.0),
    (2, 'AAPL', 25.0),
    (2, 'MSFT', 25.0),
    (2, 'GOOGL', 20.0),
    (2, 'NVDA', 15.0),
    (2, 'AMZN', 15.0),
    (3, 'JNJ', 20.0),
    (3, 'PG', 20.0),
    (3, 'XOM', 20.0),
    (3, 'JPM', 20.0),
    (3, 'WMT', 20.0);
