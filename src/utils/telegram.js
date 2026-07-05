/**
 * Telegram Notification Module
 *
 * Get instant alerts for:
 * - Liquidation opportunities
 * - Successful executions
 * - Errors and warnings
 */

class TelegramNotifier {
  constructor() {
    this.botToken = process.env.TELEGRAM_BOT_TOKEN;
    this.chatId = process.env.TELEGRAM_CHAT_ID;
    this.enabled = !!(this.botToken && this.chatId);
    this.rateLimit = new Map(); // Prevent spam
    this.rateLimitMs = 5000; // 5 seconds between same message types
  }

  /**
   * Check if notifications are enabled
   */
  isEnabled() {
    return this.enabled;
  }

  /**
   * Send a message with rate limiting
   */
  async send(message, type = 'info') {
    if (!this.enabled) return false;

    // Rate limit by type
    const lastSent = this.rateLimit.get(type) || 0;
    if (Date.now() - lastSent < this.rateLimitMs) {
      return false; // Skip to prevent spam
    }
    this.rateLimit.set(type, Date.now());

    try {
      const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.chatId,
          text: message,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
      });

      const data = await response.json();
      return data.ok;
    } catch (error) {
      console.log(`Telegram error: ${error.message}`);
      return false;
    }
  }

  /**
   * Notify about bot startup
   */
  async notifyStartup(config) {
    const message = `
🚀 <b>Flash Liquidator Started</b>

📍 Chain: ${config.chain}
💰 Min Profit: $${config.minProfitUSD}
🎯 Debt Range: $${config.minDebtUSD} - $${config.maxDebtUSD}
🔒 MEV Protection: ${config.mevEnabled ? 'ON' : 'OFF'}
🧪 Mode: ${config.dryRun ? 'SIMULATION' : 'LIVE'}

Watching for liquidation opportunities...
    `.trim();

    return await this.send(message, 'startup');
  }

  /**
   * Notify about a liquidatable position found
   */
  async notifyOpportunity(position) {
    const message = `
🎯 <b>Liquidation Opportunity!</b>

👤 Borrower: <code>${position.address.slice(0, 10)}...</code>
❤️ Health Factor: ${position.healthFactor?.toFixed(4)}
💵 Debt: $${position.totalDebtUSD?.toFixed(2)}
💰 Est. Profit: ~$${position.estimatedProfit?.toFixed(2)}
📍 Protocol: ${position.protocol}

${position.dryRun ? '🧪 DRY RUN - Not executing' : '🚀 Executing...'}
    `.trim();

    return await this.send(message, 'opportunity');
  }

  /**
   * Notify about successful liquidation
   */
  async notifySuccess(result) {
    const message = `
✅ <b>Liquidation Successful!</b>

💰 Profit: <b>$${result.profit?.toFixed(2)}</b>
⛽ Gas: $${result.gasSpent?.toFixed(2)}
📊 Net: $${(result.profit - (result.gasSpent || 0)).toFixed(2)}
🔗 Tx: <a href="${result.explorerUrl}">${result.txHash?.slice(0, 16)}...</a>

📈 Total Profit: $${result.totalProfit?.toFixed(2)}
    `.trim();

    return await this.send(message, 'success');
  }

  /**
   * Notify about failed liquidation
   */
  async notifyFailure(error, position) {
    const message = `
❌ <b>Liquidation Failed</b>

👤 Borrower: <code>${position?.address?.slice(0, 10)}...</code>
❌ Error: ${error.message?.slice(0, 100)}

Will continue monitoring...
    `.trim();

    return await this.send(message, 'failure');
  }

  /**
   * Notify about at-risk positions (summary)
   */
  async notifyAtRiskSummary(positions) {
    if (positions.length === 0) return;

    const top5 = positions.slice(0, 5);
    const list = top5.map(p =>
      `• HF ${p.healthFactor?.toFixed(3)} - $${p.totalDebtUSD?.toFixed(0)} debt`
    ).join('\n');

    const message = `
⚠️ <b>At-Risk Positions: ${positions.length}</b>

${list}

${positions.length > 5 ? `... and ${positions.length - 5} more` : ''}
    `.trim();

    return await this.send(message, 'at_risk');
  }

  /**
   * Notify about critical error
   */
  async notifyError(error) {
    const message = `
🚨 <b>Critical Error!</b>

${error.message?.slice(0, 200)}

Bot may need attention.
    `.trim();

    return await this.send(message, 'error');
  }

  /**
   * Notify about daily summary
   */
  async notifyDailySummary(stats) {
    const message = `
📊 <b>Daily Summary</b>

💰 Profit Today: $${stats.profitToday?.toFixed(2)}
📈 Total Profit: $${stats.totalProfit?.toFixed(2)}
✅ Successful: ${stats.successful}
❌ Failed: ${stats.failed}
👁️ Positions Watched: ${stats.borrowersTracked}

Keep running for more opportunities!
    `.trim();

    return await this.send(message, 'summary');
  }
}

module.exports = TelegramNotifier;

