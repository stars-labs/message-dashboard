-- Seed test keywords for demonstration
INSERT INTO keyword_tags (keyword, tag, color, priority, is_active, case_sensitive, whole_word) VALUES
    -- Authentication related
    ('verification', 'auth', '#3B82F6', 10, TRUE, FALSE, FALSE),
    ('code', 'otp', '#10B981', 8, TRUE, FALSE, TRUE),
    ('OTP', 'otp', '#F59E0B', 9, TRUE, TRUE, FALSE),
    ('password', 'auth', '#EF4444', 7, TRUE, FALSE, TRUE),
    
    -- Banking/Financial
    ('transaction', 'finance', '#8B5CF6', 6, TRUE, FALSE, FALSE),
    ('payment', 'finance', '#8B5CF6', 6, TRUE, FALSE, FALSE),
    ('balance', 'finance', '#8B5CF6', 5, TRUE, FALSE, TRUE),
    
    -- Alerts
    ('urgent', 'alert', '#DC2626', 10, TRUE, FALSE, FALSE),
    ('alert', 'alert', '#DC2626', 9, TRUE, FALSE, TRUE),
    ('warning', 'alert', '#F97316', 8, TRUE, FALSE, FALSE),
    
    -- Spam/Marketing
    ('unsubscribe', 'spam', '#6B7280', 2, TRUE, FALSE, FALSE),
    ('promo', 'marketing', '#6B7280', 3, TRUE, FALSE, FALSE),
    ('offer', 'marketing', '#6B7280', 3, TRUE, FALSE, TRUE),
    
    -- Inactive examples
    ('test', 'debug', '#14B8A6', 1, FALSE, FALSE, FALSE),
    ('debug', 'debug', '#14B8A6', 1, FALSE, FALSE, FALSE);