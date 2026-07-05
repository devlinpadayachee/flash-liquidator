/**
 * Borrower Cache - Persistent Storage
 *
 * Saves borrowers to disk so you don't lose them on restart.
 * Also tracks which positions are closed/liquidated to avoid wasting RPC calls.
 */

const fs = require('fs');
const path = require('path');

class BorrowerCache {
  constructor(chainName) {
    this.chainName = chainName?.toUpperCase() || 'UNKNOWN';
    this.cacheDir = path.join(process.cwd(), 'cache');
    this.cacheFile = path.join(this.cacheDir, `${this.chainName.toLowerCase()}_borrowers.json`);
    this.closedFile = path.join(this.cacheDir, `${this.chainName.toLowerCase()}_closed.json`);
    this.liquidatableFile = path.join(this.cacheDir, `${this.chainName.toLowerCase()}_liquidatable.json`);

    // In-memory data
    this.borrowers = new Map();
    this.closedPositions = new Set(); // Addresses that have been liquidated/closed
    this.liquidatablePositions = new Map(); // Positions that were liquidatable (need recheck on restart)
    this.lastScanBlock = 0;
    this.lastSaveTime = 0;

    // Stats
    this.stats = {
      loaded: 0,
      saved: 0,
      closedTracked: 0,
      liquidatableTracked: 0,
    };

    // Ensure cache directory exists
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  /**
   * Load borrowers from cache file
   */
  load() {
    try {
      if (fs.existsSync(this.cacheFile)) {
        const data = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));

        // Load borrowers
        if (data.borrowers && Array.isArray(data.borrowers)) {
          for (const b of data.borrowers) {
            if (b.address) {
              this.borrowers.set(b.address.toLowerCase(), b);
            }
          }
        }

        // Load metadata
        this.lastScanBlock = data.lastScanBlock || 0;

        this.stats.loaded = this.borrowers.size;
        console.log(`   📂 Loaded ${this.borrowers.size} borrowers from cache`);
        console.log(`      Last scan block: ${this.lastScanBlock}`);
      }

      // Load closed positions
      if (fs.existsSync(this.closedFile)) {
        const closedData = JSON.parse(fs.readFileSync(this.closedFile, 'utf8'));
        if (closedData.closed && Array.isArray(closedData.closed)) {
          for (const addr of closedData.closed) {
            this.closedPositions.add(addr.toLowerCase());
          }
        }
        this.stats.closedTracked = this.closedPositions.size;
        console.log(`      Closed positions: ${this.closedPositions.size}`);
      }

      // Load liquidatable positions (need recheck on restart!)
      if (fs.existsSync(this.liquidatableFile)) {
        const liqData = JSON.parse(fs.readFileSync(this.liquidatableFile, 'utf8'));
        if (liqData.positions && Array.isArray(liqData.positions)) {
          for (const pos of liqData.positions) {
            if (pos.address) {
              this.liquidatablePositions.set(pos.address.toLowerCase(), pos);
            }
          }
        }
        this.stats.liquidatableTracked = this.liquidatablePositions.size;
        if (this.liquidatablePositions.size > 0) {
          console.log(`      Liquidatable (pending recheck): ${this.liquidatablePositions.size}`);
        }
      }

      return true;
    } catch (error) {
      console.log(`   ⚠️ Cache load error: ${error.message}`);
      return false;
    }
  }

  /**
   * Save borrowers to cache file
   */
  save() {
    try {
      // Only save if we have data and it's been at least 30 seconds
      if (this.borrowers.size === 0) return false;

      const now = Date.now();
      if (now - this.lastSaveTime < 30000) return false;

      // Save borrowers (only essential data to keep file small)
      const borrowerData = [];
      for (const [addr, b] of this.borrowers) {
        borrowerData.push({
          address: b.address,
          protocol: b.protocol,
          healthFactor: b.healthFactor,
          totalDebtUSD: b.totalDebtUSD,
          totalCollateralUSD: b.totalCollateralUSD,
          lastChecked: b.lastChecked,
        });
      }

      const data = {
        chain: this.chainName,
        lastScanBlock: this.lastScanBlock,
        savedAt: new Date().toISOString(),
        borrowerCount: borrowerData.length,
        borrowers: borrowerData,
      };

      fs.writeFileSync(this.cacheFile, JSON.stringify(data, null, 2));

      // Save closed positions
      const closedData = {
        chain: this.chainName,
        savedAt: new Date().toISOString(),
        count: this.closedPositions.size,
        closed: Array.from(this.closedPositions),
      };
      fs.writeFileSync(this.closedFile, JSON.stringify(closedData, null, 2));

      // Save liquidatable positions
      if (this.liquidatablePositions.size > 0) {
        const liqData = {
          chain: this.chainName,
          savedAt: new Date().toISOString(),
          count: this.liquidatablePositions.size,
          positions: Array.from(this.liquidatablePositions.values()).map(p => ({
            address: p.address,
            protocol: p.protocol,
            healthFactor: p.healthFactor,
            totalDebtUSD: p.totalDebtUSD,
            totalCollateralUSD: p.totalCollateralUSD,
            lastChecked: p.lastChecked,
          })),
        };
        fs.writeFileSync(this.liquidatableFile, JSON.stringify(liqData, null, 2));
      }

      this.lastSaveTime = now;
      this.stats.saved++;

      return true;
    } catch (error) {
      console.error(`   ⚠️ Cache save error: ${error.message}`);
      return false;
    }
  }

  /**
   * Get all borrowers
   */
  getBorrowers() {
    return this.borrowers;
  }

  /**
   * Add or update a borrower
   */
  set(address, data) {
    const addr = address.toLowerCase();

    // Don't add if in closed list
    if (this.closedPositions.has(addr)) {
      return false;
    }

    this.borrowers.set(addr, {
      ...this.borrowers.get(addr),
      ...data,
      address: data.address || address,
    });

    return true;
  }

  /**
   * Get a borrower
   */
  get(address) {
    return this.borrowers.get(address.toLowerCase());
  }

  /**
   * Check if borrower exists
   */
  has(address) {
    return this.borrowers.has(address.toLowerCase());
  }

  /**
   * Mark a position as closed (liquidated or repaid)
   */
  markClosed(address) {
    const addr = address.toLowerCase();
    this.closedPositions.add(addr);
    this.borrowers.delete(addr);
    this.stats.closedTracked = this.closedPositions.size;
  }

  /**
   * Check if position is marked as closed
   */
  isClosed(address) {
    if (!address) return false;
    return this.closedPositions.has(address.toLowerCase());
  }

  /**
   * Reactivate a closed position (they borrowed again!)
   */
  reactivate(address) {
    if (!address) return false;
    const addr = address.toLowerCase();
    if (this.closedPositions.has(addr)) {
      this.closedPositions.delete(addr);
      this.stats.closedTracked = this.closedPositions.size;
      return true;
    }
    return false;
  }

  /**
   * Clear old closed positions to allow re-checking
   * @param {number} maxAge - Max age in milliseconds (default 7 days)
   * @param {number} maxCount - Max closed positions to keep (default 5000)
   */
  pruneClosedPositions(maxAge = 7 * 24 * 60 * 60 * 1000, maxCount = 5000) {
    const beforeCount = this.closedPositions.size;

    if (beforeCount <= maxCount) {
      return 0; // Under limit, no pruning needed
    }

    // Since Set doesn't store timestamps, just clear oldest entries
    // by converting to array and keeping most recent
    const closedArray = Array.from(this.closedPositions);
    const toRemove = closedArray.slice(0, closedArray.length - maxCount);

    for (const addr of toRemove) {
      this.closedPositions.delete(addr);
    }

    this.stats.closedTracked = this.closedPositions.size;

    const removed = beforeCount - this.closedPositions.size;
    if (removed > 0) {
      console.log(`   🗑️ Pruned ${removed} old closed positions (kept ${this.closedPositions.size})`);
    }

    return removed;
  }

  /**
   * Clear ALL closed positions (use with caution - will re-check everything)
   */
  clearClosedPositions() {
    const count = this.closedPositions.size;
    this.closedPositions.clear();
    this.stats.closedTracked = 0;
    return count;
  }

  /**
   * Add a liquidatable position
   */
  addLiquidatable(position) {
    if (!position?.address) return false;
    const addr = position.address.toLowerCase();
    this.liquidatablePositions.set(addr, {
      ...position,
      address: position.address,
      savedAt: Date.now(),
    });
    this.stats.liquidatableTracked = this.liquidatablePositions.size;
    return true;
  }

  /**
   * Remove a liquidatable position (executed or no longer valid)
   */
  removeLiquidatable(address) {
    if (!address) return false;
    const addr = address.toLowerCase();
    const result = this.liquidatablePositions.delete(addr);
    this.stats.liquidatableTracked = this.liquidatablePositions.size;
    return result;
  }

  /**
   * Get all cached liquidatable positions (for recheck on restart)
   */
  getLiquidatablePositions() {
    // Filter out invalid positions (HF=0)
    return Array.from(this.liquidatablePositions.values()).filter(p =>
      p.healthFactor > 0.01 && p.healthFactor < 1.0
    );
  }

  /**
   * Check if position is in liquidatable cache
   */
  isLiquidatable(address) {
    if (!address) return false;
    return this.liquidatablePositions.has(address.toLowerCase());
  }

  /**
   * Clear liquidatable cache (after successful verification)
   */
  clearLiquidatableCache() {
    this.liquidatablePositions.clear();
    this.stats.liquidatableTracked = 0;
    // Delete the file too
    try {
      if (fs.existsSync(this.liquidatableFile)) {
        fs.unlinkSync(this.liquidatableFile);
      }
    } catch (e) {}
  }

  /**
   * Purge invalid positions (HF=0, HF<=0.01) from all caches
   * Returns count of positions purged
   */
  purgeInvalidPositions() {
    let purged = 0;

    // Remove invalid borrowers
    for (const [addr, borrower] of this.borrowers) {
      if (borrower.healthFactor !== null && borrower.healthFactor !== undefined && borrower.healthFactor <= 0.01) {
        this.borrowers.delete(addr);
        this.closedPositions.add(addr);
        purged++;
      }
    }

    // Remove invalid liquidatable positions
    for (const [addr, pos] of this.liquidatablePositions) {
      if (pos.healthFactor !== null && pos.healthFactor !== undefined && pos.healthFactor <= 0.01) {
        this.liquidatablePositions.delete(addr);
        this.closedPositions.add(addr);
        purged++;
      }
    }

    // Update stats
    this.stats.closedTracked = this.closedPositions.size;
    this.stats.liquidatableTracked = this.liquidatablePositions.size;

    // Save if we purged anything
    if (purged > 0) {
      this.save();
      console.log(`   🗑️ Purged ${purged} invalid positions from cache`);
    }

    return purged;
  }

  /**
   * Delete a borrower
   */
  delete(address) {
    return this.borrowers.delete(address.toLowerCase());
  }

  /**
   * Get borrowers that need health check
   * Smart filtering: only positions that could have become risky
   */
  getBorrowersNeedingCheck(options = {}) {
    const {
      maxAge = 60000,        // Only check if not checked in last 60s
      prioritizeRisky = true, // Check risky positions first
      limit = 500,           // Max to return
    } = options;

    const now = Date.now();
    const needsCheck = [];

    for (const [addr, b] of this.borrowers) {
      // Skip if recently checked
      if (b.lastChecked && (now - b.lastChecked) < maxAge) {
        continue;
      }

      // Skip closed positions
      if (this.closedPositions.has(addr)) {
        continue;
      }

      needsCheck.push(b);
    }

    // Sort by risk (lowest HF first)
    if (prioritizeRisky) {
      needsCheck.sort((a, b) => {
        const hfA = a.healthFactor ?? 999;
        const hfB = b.healthFactor ?? 999;
        return hfA - hfB;
      });
    }

    return needsCheck.slice(0, limit);
  }

  /**
   * Set last scanned block
   */
  setLastScanBlock(block) {
    this.lastScanBlock = block;
  }

  /**
   * Get last scanned block
   */
  getLastScanBlock() {
    return this.lastScanBlock;
  }

  /**
   * Get stats
   */
  getStats() {
    return {
      ...this.stats,
      totalBorrowers: this.borrowers.size,
      closedPositions: this.closedPositions.size,
      lastScanBlock: this.lastScanBlock,
    };
  }

  /**
   * Clear cache (use with caution!)
   */
  clear() {
    this.borrowers.clear();
    this.closedPositions.clear();
    this.lastScanBlock = 0;

    try {
      if (fs.existsSync(this.cacheFile)) {
        fs.unlinkSync(this.cacheFile);
      }
      if (fs.existsSync(this.closedFile)) {
        fs.unlinkSync(this.closedFile);
      }
    } catch (e) {}
  }

  /**
   * Get size
   */
  get size() {
    return this.borrowers.size;
  }
}

module.exports = BorrowerCache;

