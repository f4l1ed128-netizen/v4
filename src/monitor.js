import { buildAlertPayload } from './template.js';
import { normalizeUploadMode, supportsVideoUploads, newUploadVideos, MAX_SEEN_UPLOADS } from './uploads.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export class Monitor {
  constructor(client, store, platforms, options = {}) {
    this.client = client;
    this.store = store;
    this.platforms = platforms;
    this.interval = Math.max(15, Math.min(3600, Number(options.interval || 15))) * 1000;
    this.notifyOnStartup = options.notifyOnStartup === true;
    this.busy = false;
    this.timer = null;
    this.lastTick = null;
    this.errors = new Map();
    // YouTube LIVE uses search.list, which has a small daily limit. This
    // schedule does not stop video-upload checks or other platform checks.
    this.youtubeScanTimeZone = process.env.YOUTUBE_SCAN_TIMEZONE || 'Asia/Amman';
    this.youtubeScanStartHour = Math.max(0, Math.min(23, Number(process.env.YOUTUBE_SCAN_START_HOUR ?? 6) || 0));
    this.youtubeScanHours = Math.max(1, Math.min(24, Number(process.env.YOUTUBE_SCAN_HOURS ?? 24) || 24));
    this.youtubeSearchDailyBudget = Math.max(1, Math.min(90, Number(process.env.YOUTUBE_SEARCH_DAILY_BUDGET ?? 90) || 90));
    this.youtubeLastLiveCheck = new Map();
    this.lastPlatformChecks = new Map();
    this.lastFeedChecks = new Map();
    this.kickCheckSeconds = Math.max(20, Math.min(600, Number(process.env.KICK_CHECK_SECONDS || 30)));
    this.twitchCheckSeconds = Math.max(20, Math.min(600, Number(process.env.TWITCH_CHECK_SECONDS || 30)));
    this.tiktokLiveCheckSeconds = Math.max(30, Math.min(900, Number(process.env.TIKTOK_LIVE_CHECK_SECONDS || 60)));
    this.tiktokPostsCheckSeconds = Math.max(300, Math.min(86400, Number(process.env.TIKTOK_POSTS_CHECK_SECONDS || 900)));
    this.youtubeUploadSeconds = Math.max(30, Math.min(1800, Number(process.env.YOUTUBE_UPLOAD_SECONDS || 60)));
    // Each upload-feed scan costs approximately 2 YouTube read requests.
    // Reserve some of the 10,000/day default general-endpoint quota for verification and manual tests.
    this.youtubeReadDailyBudget = Math.max(100, Math.min(8000, Number(process.env.YOUTUBE_READ_DAILY_BUDGET || 6000)));
    this.fastTwitchWebsocket = false;
    this.twitchEventSubscribers = new Set();
    // Serialize per-subscription delivery, including /alerts test and polling.
    this.deliveryQueues = new Map();
  }
  async start() {
    await this.tick();
    this.timer = setInterval(() => this.tick().catch(err => console.error('[ALERTS] tick failed:', err)), this.interval);
    this.timer.unref?.();
  }
  stop() { if (this.timer) clearInterval(this.timer); }
  youtubeInScanWindow(date = new Date()) {
    // Use a fixed timezone rather than the hosting server's timezone.
    const hour = Number(new Intl.DateTimeFormat('en-US', {
      timeZone: this.youtubeScanTimeZone,
      hour: '2-digit', hourCycle: 'h23',
    }).format(date));
    const hoursSinceStart = (hour - this.youtubeScanStartHour + 24) % 24;
    return hoursSinceStart < this.youtubeScanHours;
  }
  youtubeMinCheckGapMs(items) {
    const unique = new Set(items.filter(s => s.platform === 'youtube' &&
      normalizeUploadMode(s.platform, s.mode) !== 'videos')
      .map(s => s.channelId || s.username));
    if (!unique.size) return Infinity;
    // Spread the shared search budget evenly across all tracked channels.
    // With one creator, 24 hours and a 90-query budget: check ~every 16 min.
    const minutes = Math.ceil(this.youtubeScanHours * 60 * unique.size / this.youtubeSearchDailyBudget);
    return Math.max(60_000, minutes * 60_000);
  }
  youtubeFeedGapMs(items) {
    const channels = new Set(items.filter(x => x.platform === 'youtube' && x.channelId)
      .map(x => x.channelId));
    // Two read operations per playlist check: playlistItems.list + videos.list.
    // We count ALL tracked channels, including stream-only subscriptions, since
    // their uploads feed can reveal currently LIVE public streams.
    const secondsToStayWithinBudget = channels.size * 2 * 86400 / this.youtubeReadDailyBudget;
    return Math.ceil(Math.max(this.youtubeUploadSeconds, secondsToStayWithinBudget) / (this.interval / 1000)) * this.interval;
  }
  liveGapMs(platform, name = '') {
    if (platform === 'kick') return this.kickCheckSeconds * 1000;
    // Maintain fallback checks for missed Twitch WebSocket events.
    if (platform === 'twitch') return (this.twitchEventSubscribers.has(String(name).toLowerCase()) ? 300 : this.twitchCheckSeconds) * 1000;
    if (platform === 'tiktok') return this.tiktokLiveCheckSeconds * 1000;
    return this.interval;
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    this.lastTick = Date.now();
    try {
      const liveChecks = new Map();
      const feedChecks = new Map();
      const subscriptions = [...this.store.list()];
      const youtubeActive = this.youtubeInScanWindow();
      const youtubeGap = this.youtubeMinCheckGapMs(subscriptions);
      const feedGap = this.youtubeFeedGapMs(subscriptions);
      const now = Date.now();
      for (const item of subscriptions) {
        if (!this.store.find(item.guildId, item.id)) continue;
        const key = `${item.platform}:${item.channelId || item.username}`;
        const mode = normalizeUploadMode(item.platform, item.mode);
        const shouldLive = mode !== 'videos';
        const shouldVideos = supportsVideoUploads(item.platform) && mode !== 'streams';
        const lastLive = this.store.find(item.guildId, item.id);
        let liveNow = lastLive?.lastStatus === 'LIVE';
        const liveGap = item.platform === 'youtube' ? youtubeGap : this.liveGapMs(item.platform, item.username);
        const dueLive = shouldLive && (liveChecks.has(key) || ((item.platform !== 'youtube' || youtubeActive) &&
          now - (item.platform === 'youtube'
            ? this.youtubeLastLiveCheck.get(key) ?? -Infinity
            : this.lastPlatformChecks.get(key) ?? -Infinity) >= liveGap));
        if (dueLive) {
          try {
            if (!liveChecks.has(key)) {
              if (item.platform === 'youtube') this.youtubeLastLiveCheck.set(key, now);
              else this.lastPlatformChecks.set(key, now);
              liveChecks.set(key, this.platforms.check(item));
            }
            const result = await liveChecks.get(key);
            liveNow = !!result?.live;
            await this.process(item, result);
            this.errors.delete(item.id);
          } catch (error) {
            this.recordError(item, 'stream', error);
            // An API error is NOT a confirmed offline result.
            liveNow = this.store.find(item.guildId, item.id)?.lastStatus === 'LIVE';
          }
        }
        // YouTube's low-cost uploads playlist can also reveal public active
        // streams, including some premieres, without using search.list quota.
        // Verify the video's live state from videos.list before dispatching.
        // Not all livestreams appear in this playlist; search fallback remains.
        const needYoutubeFeed = item.platform === 'youtube' && (shouldLive || shouldVideos);
        const dueYoutubeFeed = needYoutubeFeed && !liveNow && (feedChecks.has(key) ||
          now - (this.lastFeedChecks.get(key) ?? -Infinity) >= feedGap);
        const dueOtherFeed = item.platform === 'tiktok' && shouldVideos && !liveNow &&
          (feedChecks.has(key) || now - (this.lastFeedChecks.get(key) ?? -Infinity) >= this.tiktokPostsCheckSeconds * 1000);
        if (dueYoutubeFeed || dueOtherFeed) {
          try {
            if (!feedChecks.has(key)) {
              this.lastFeedChecks.set(key, now);
              feedChecks.set(key, this.platforms.uploads(item));
            }
            const feed = await feedChecks.get(key);
            const activeLive = item.platform === 'youtube' && shouldLive ? feed?.activeLive : null;
            if (activeLive && !liveNow) {
              await this.process(item, activeLive);
              liveNow = true;
            }
            if (shouldVideos && !liveNow) await this.processUploads(item, feed);
            this.errors.delete(item.id);
          } catch (error) {
            if (item.platform === 'youtube') this.lastFeedChecks.delete(key); // retry after a Discord send failure
            this.recordError(item, 'upload', error);
          }
        }
        // No per-creator artificial sleep. The checks are rate-controlled above,
        // and Discord deliveries are serialized per saved subscription.
      }
    } finally { this.busy = false; }
  }
  async serializeDelivery(item, task) {
    // In-memory queue prevents simultaneous polling and /alerts test from
    // posting the same ID before either call saves the sent history.
    const key = `${item.guildId}:${item.id}`;
    const previous = this.deliveryQueues.get(key) || Promise.resolve();
    const running = previous.catch(() => {}).then(task);
    this.deliveryQueues.set(key, running);
    try { return await running; }
    finally {
      if (this.deliveryQueues.get(key) === running) this.deliveryQueues.delete(key);
    }
  }
  recordError(item, kind, error) {
    const message = `${kind}: ${String(error?.message || error).slice(0, 180)}`;
    this.errors.set(item.id, message);
    this.store.patch(item.guildId, item.id, { lastError: message, lastChecked: new Date().toISOString() });
    console.error(`[ALERTS] ${item.platform}/${item.username} ${kind}:`, message);
  }
  async post(item, info, kind) {
    const channel = await this.client.channels.fetch(item.destinationId).catch(() => null);
    if (!channel?.isTextBased?.() || typeof channel.send !== 'function') {
      throw new Error('Alert destination missing or bot cannot send there.');
    }
    await channel.send(buildAlertPayload(item, info, false, kind));
  }
  async processUploads(item, result) {
    return this.serializeDelivery(item, async () => {
      const stamp = new Date().toISOString();
      const current = this.store.find(item.guildId, item.id);
      if (!current) return;
      const recentIds = (result?.allIds || []).filter(Boolean).map(String);
      if (!current.uploadsInitialized) {
        // Initial baseline: don't announce a backlog of old videos.
        this.store.patch(item.guildId, item.id, {
          uploadsInitialized: true,
          seenUploadIds: [...new Set([...(current.seenUploadIds || []), ...recentIds])].slice(0, MAX_SEEN_UPLOADS),
          // On upgrade, seenUploadIds may include previously announced uploads.
          // Treat them as already handled to avoid re-posting after a restart.
          announcedVideoIds: [...new Set([...(current.announcedVideoIds || []), ...(current.seenUploadIds || []), ...recentIds])],
          lastUploadChecked: stamp, lastError: null,
        });
        return;
      }
      const handled = new Set([...(current.announcedVideoIds || []), ...(current.seenUploadIds || [])].map(String));
      const eligible = (result?.videos || []).filter(v => v?.id && /^https:\/\//i.test(v.url || ''));
      // Only the LATEST eligible upload matters. Do not post older unseen
      // videos if the newest one was already handled, even after an outage.
      const latest = eligible.reduce((best, next) => {
        if (!best) return next;
        const a = Date.parse(best.publishedAt || '');
        const b = Date.parse(next.publishedAt || '');
        return Number.isFinite(b) && (!Number.isFinite(a) || b > a) ? next : best;
      }, null);
      if (latest && !handled.has(String(latest.id))) {
        // Only mark a video handled AFTER Discord confirms it was sent.
        await this.post(item, latest, 'video');
        handled.add(String(latest.id));
        this.store.patch(item.guildId, item.id, {
          lastVideoAlertAt: new Date().toISOString(), lastVideoId: String(latest.id),
          announcedVideoIds: [...handled],
        });
        console.log(`[ALERTS] Posted ${item.platform} video ${latest.id} for ${item.username} to ${item.destinationId}`);
      }
      // Mark other fetched uploads as handled, without posting stale backlogs.
      // This is persisted, so the 24/7 schedule and restarts never replay them.
      for (const id of recentIds) handled.add(id);
      for (const video of eligible) handled.add(String(video.id));
      this.store.patch(item.guildId, item.id, {
        seenUploadIds: [...new Set([...recentIds, ...(current.seenUploadIds || [])])].slice(0, MAX_SEEN_UPLOADS),
        announcedVideoIds: [...handled], lastUploadChecked: stamp, lastError: null,
      });
    });
  }
  async process(item, result) {
    return this.serializeDelivery(item, async () => {
      const stamp = new Date().toISOString();
      const current = this.store.find(item.guildId, item.id);
      if (!current) return;
      if (!current.initialized) {
        const baselineStreamId = result.live ? String(result.id || `live:${item.username}`) : null;
        this.store.patch(item.guildId, item.id, {
          initialized: true,
          wasLive: this.notifyOnStartup && result.live ? false : !!result.live,
          lastStreamId: this.notifyOnStartup && result.live ? null : baselineStreamId,
          lastChecked: stamp, lastStatus: result.live ? 'LIVE' : 'OFFLINE', lastError: null,
          offlineChecks: this.notifyOnStartup && result.live ? 2 : 0,
          ...(!this.notifyOnStartup && baselineStreamId ? {
            seenStreamIds: [...new Set([...(current.seenStreamIds || []), baselineStreamId])],
          } : {}),
        });
        if (!this.notifyOnStartup || !result.live) return;
      }
      if (!result.live) {
        const fresh = this.store.find(item.guildId, item.id);
        const offlineChecks = (fresh.offlineChecks || 0) + 1;
        this.store.patch(item.guildId, item.id, {
          offlineChecks, lastChecked: stamp, lastStatus: 'OFFLINE', lastError: null,
          ...(offlineChecks >= 2 ? { wasLive: false } : {}),
        });
        return;
      }
      const streamId = String(result.id || `live:${item.username}`);
      const fresh = this.store.find(item.guildId, item.id);
      const prior = new Set([...(fresh.seenStreamIds || []).map(String),
        ...(fresh.lastStreamId ? [String(fresh.lastStreamId)] : [])]);
      const shouldSend = !prior.has(streamId);
      if (shouldSend) {
        await this.post(item, result, 'stream');
        console.log(`[ALERTS] Posted ${item.platform} stream ${streamId} for ${item.username} to ${item.destinationId}`);
      }
      this.store.patch(item.guildId, item.id, {
        wasLive: true, lastStreamId: streamId,
        seenStreamIds: [...new Set([...prior, streamId])],
        lastChecked: stamp, lastStatus: 'LIVE', lastError: null, offlineChecks: 0,
        ...(shouldSend ? { lastAlertAt: stamp } : {}),
      });
    });
  }
  // Fetch the latest eligible public upload, not the creator's channel page.
  // Fetch latest video for stream-first test; delivery is deduplicated separately.
  async latestTestVideo(item) {
    const feed = await this.platforms.uploads(item);
    const videos = (feed?.videos || []).filter(v => v && /^https:\/\//i.test(v.url || ''));
    if (!videos.length) {
      throw new Error('No recent public video posts found. No test alert was sent.');
    }
    return videos.reduce((latest, candidate) => {
      const a = Date.parse(latest.publishedAt || '');
      const b = Date.parse(candidate.publishedAt || '');
      return Number.isFinite(b) && (!Number.isFinite(a) || b > a) ? candidate : latest;
    });
  }

  async sendTest(item, kind = 'stream') {
    let info;
    let alertKind = kind;
    if (kind === 'video') {
      if (!supportsVideoUploads(item.platform)) {
        throw new Error('Video test alerts are available for YouTube and TikTok only.');
      }
      info = await this.latestTestVideo(item);
    } else if (kind === 'stream') {
      // Priority: an active livestream always wins. If the creator is offline,
      // fall back to their latest YouTube video / TikTok post instead.
      let result;
      try {
        result = await this.platforms.check(item);
      } catch (error) {
        // TikTok's unofficial LIVE library sometimes throws even for an
        // offline creator. Try the latest public post rather than failing
        // the entire stream-first preview. Never claim the creator is offline.
        if (item.platform !== 'tiktok') throw error;
        console.warn(`[ALERTS] TikTok LIVE check unavailable for ${item.username}; trying last post: ${String(error.message).slice(0, 150)}`);
        try {
          info = await this.latestTestVideo(item);
          alertKind = 'video';
        } catch (postError) {
          throw new Error(`TikTok LIVE and post checks both failed. LIVE: ${String(error.message).slice(0, 110)}; posts: ${String(postError.message).slice(0, 180)}`);
        }
      }
      if (info) { /* stream check unavailable, post fallback already selected */ }
      else if (result?.live) {
        if (!/^https:\/\//i.test(result.url || '')) {
          throw new Error('The creator is LIVE but no valid stream URL was returned. No alert was sent.');
        }
        info = result;
      } else if (supportsVideoUploads(item.platform)) {
        info = await this.latestTestVideo(item);
        alertKind = 'video';
      } else {
        throw new Error('This creator is not currently LIVE and the platform has no video-post fallback. No alert was sent.');
      }
    } else {
      throw new Error('Unknown test kind. Choose stream or video.');
    }

    return this.serializeDelivery(item, async () => {
      const current = this.store.find(item.guildId, item.id);
      if (!current) throw new Error('Subscription was removed.');
      const id = String(info.id || (alertKind === 'stream' ? `live:${item.username}` : ''));
      if (!id) throw new Error('The provider did not return an item ID; cannot safely prevent duplicates.');
      const prior = alertKind === 'video'
        ? new Set([...(current.announcedVideoIds || []).map(String), ...(current.seenUploadIds || []).map(String),
          ...(current.lastVideoId ? [String(current.lastVideoId)] : [])])
        : new Set([...(current.seenStreamIds || []).map(String), ...(current.lastStreamId ? [String(current.lastStreamId)] : [])]);
      if (prior.has(id)) {
        throw new Error(`Nothing new: this ${alertKind === 'video' ? 'video/post' : 'livestream'} was already handled. No notification sent.`);
      }
      const channel = await this.client.channels.fetch(item.destinationId);
      if (!channel?.isTextBased?.() || typeof channel.send !== 'function') {
        throw new Error('Notification channel is not accessible.');
      }
      await channel.send(buildAlertPayload(item, info, true, alertKind));
      const when = new Date().toISOString();
      if (alertKind === 'video') {
        this.store.patch(item.guildId, item.id, {
          announcedVideoIds: [...prior, id],
          seenUploadIds: [id, ...(current.seenUploadIds || []).filter(x => x !== id)].slice(0, MAX_SEEN_UPLOADS),
          lastVideoAlertAt: when, lastVideoId: id,
        });
      } else {
        this.store.patch(item.guildId, item.id, {
          initialized: true, wasLive: true, lastStreamId: id, lastStatus: 'LIVE',
          seenStreamIds: [...prior, id], offlineChecks: 0, lastAlertAt: when,
        });
      }
    });
  }

}
