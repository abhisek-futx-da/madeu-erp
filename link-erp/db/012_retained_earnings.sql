-- Closing a year moves the profit or loss to retained earnings. Without that
-- transfer the balance sheet cannot balance, because income and expense close
-- to the P&L and their net has to land somewhere.

alter type posting_role add value if not exists 'retained_earnings';
