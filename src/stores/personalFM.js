import { defineStore } from 'pinia';
import { get } from '../utils/request';
import { useMusicQueueStore } from './musicQueue';
import { MoeAuthStore } from './store';

const QUALITY_LEVELS = ['128', '320', 'flac', 'high', 'viper_atmos', 'viper_clear', 'viper_tape'];
const QUALITY_LABELS = {
    '128': '标准',
    '320': '高品',
    flac: 'FLAC',
    high: 'Hi-Res',
    viper_atmos: '全景声',
    viper_clear: '超清',
    viper_tape: '母带'
};

const normalizeQuality = (quality) => {
    return QUALITY_LEVELS.includes(quality) ? quality : '128';
};

const getFallbackChain = (quality) => QUALITY_LEVELS.slice(0, QUALITY_LEVELS.indexOf(normalizeQuality(quality)) + 1).reverse();

const getQualityLabel = (quality) => QUALITY_LABELS[quality] || '';

export const usePersonalFMStore = defineStore('PersonalFM', {
    state: () => ({
        isEnabled: false,           // 是否启用私人FM模式
        currentSong: null,          // 当前播放的歌曲对象 { hash, name, cover, author, timelen, url, songid }
        pool: [],                   // 候选池：待播放的歌曲
        history: [],                // 已播放历史栈
        isLoading: false,           // 是否正在加载歌曲
        maxPoolSize: 20,            // 池子上限
        historyLimit: 20, // 历史栈上限
        songPoolId: 0,              // AI模式：0：Alpha 根据口味推荐相似歌曲, 1：Beta 根据风格推荐相似歌曲, 2：Gamma
        mode: 'normal',             // 获取模式：normal：发现，small：小众
        m_type: 0,                  // 音乐类型：根据mode自动设置，normal→0，small→3
        urlCache: {},               // 歌曲URL缓存
        maxCacheSize: 20,           // 最大缓存歌曲数量
        poolThreshold: 2,           // 池子低于此值时预加载
        isPreloading: false,        // 是否正在预加载
        lastFetchTime: 0,           // 上次获取歌曲的时间
        fetchCooldown: 30000,       // 获取冷却时间30秒
    }),

    getters: {
        // 池子中歌曲数量
        poolSize: (state) => state.pool.length,

        // 是否需要预加载（池子低于阈值）
        needsMoreSongs: (state) => state.isEnabled && state.pool.length < state.poolThreshold,

        // 是否可以预加载
        canPreload: (state) => {
            const now = Date.now();
            return !state.isPreloading &&
                   !state.isLoading &&
                   (now - state.lastFetchTime) > state.fetchCooldown;
        },

        // 是否有上一首（历史栈中是否有歌曲）
        hasPrevious: (state) => state.history.length > 0,
    },

    actions: {
        // 启用私人FM模式
        async enableFM() {
            this.isEnabled = true;
            this.currentSong = null;
            this.pool = [];
            this.history = [];

            // 清空播放列表
            const musicQueueStore = useMusicQueueStore();
            musicQueueStore.clearQueue();

            // 启用FM时立即加载一批歌曲
            await this.fetchFMSongs();
        },

        // 保存最后一首FM歌曲信息到本地存储
        saveLastFMSong(song) {
            if (!song) return;
            const lastFMSong = {
                hash: song.hash,
                songid: song.songid || '',
                playtime: song.timelen || song.timeLength || 0
            };
            localStorage.setItem('personalFM_lastSong', JSON.stringify(lastFMSong));
        },

        // 获取本地存储的最后一首FM歌曲信息
        getLastFMSong() {
            try {
                const lastSongStr = localStorage.getItem('personalFM_lastSong');
                if (lastSongStr) {
                    return JSON.parse(lastSongStr);
                }
            } catch (error) {
                console.error('[PersonalFM] 获取本地存储的FM歌曲信息出错:', error);
            }
            return null;
        },

        // 禁用私人FM模式
        disableFM() {
            this.isEnabled = false;
            this.currentSong = null;
            this.pool = [];
            this.history = [];
        },

        // 从池子中随机取一首歌
        pickRandomFromPool() {
            if (this.pool.length === 0) return null;
            const randomIndex = Math.floor(Math.random() * this.pool.length);
            const song = this.pool.splice(randomIndex, 1)[0];
            return song;
        },

        // 播放下一首（从池子随机取）
        async playNext() {
            // 如果当前有歌，压入历史
            if (this.currentSong) {
                this.pushHistory(this.currentSong);
            }

            // 如果池子空了或低于阈值，先获取新歌
            if (this.pool.length === 0) {
                await this.fetchFMSongs();
            }

            // 如果还是空的，说明获取失败
            if (this.pool.length === 0) {
                return null;
            }

            // 从池子随机取一首
            this.currentSong = this.pickRandomFromPool();
            this.saveLastFMSong(this.currentSong);

            // 检查是否需要预加载
            if (this.needsMoreSongs) {
                this.preloadSongs();
            }

            return this.currentSong;
        },

        // 播放上一首（从历史栈弹出）
        playPrevious() {
            if (this.history.length === 0) return null;

            // 当前歌放回池子
            if (this.currentSong) {
                this.pool.unshift(this.currentSong);
            }

            this.currentSong = this.history.pop();
            this.saveLastFMSong(this.currentSong);
            return this.currentSong;
        },

        // 不喜欢当前歌曲：告诉服务器，然后切下一首
        async dislikeCurrentSong() {
            if (!this.currentSong) return;

            const song = this.currentSong;
            try {
                // 调用API标记不喜欢
                await get('/personal/fm', {
                    hash: song.hash,
                    songid: song.songid || '',
                    playtime: song.timelen || 0,
                    mode: this.mode,
                    action: 'garbage',
                    song_pool_id: this.songPoolId,
                    m_type: this.m_type,
                    remain_songcnt: 0,
                    timestamp: Date.now(),
                });
            } catch (error) {
                console.error('[PersonalFM] 标记不喜欢出错:', error);
            }

            // 不压入历史，直接切下一首
            this.currentSong = null;

            // 如果池子空了，先获取新歌
            if (this.pool.length === 0) {
                await this.fetchFMSongs();
            }

            if (this.pool.length === 0) {
                return null;
            }

            this.currentSong = this.pickRandomFromPool();
            this.saveLastFMSong(this.currentSong);

            if (this.needsMoreSongs) {
                this.preloadSongs();
            }

            return this.currentSong;
        },

        // 将歌曲压入历史栈
        pushHistory(song) {
            if (!song) return;
            this.history.push(song);
            // 限制历史栈长度
            if (this.history.length > this.historyLimit) {
                this.history.shift();
            }
        },

        // 标记歌曲播放完成
        markSongCompleted() {
            if (this.currentSong) {
                this.currentSong.is_overplay = 1;
                this.saveLastFMSong(this.currentSong);

                if (this.needsMoreSongs) {
                    this.preloadSongs();
                }
            }
        },

        // 获取私人FM歌曲
        async fetchFMSongs() {
            if (this.isLoading) return;

            this.isLoading = true;
            this.lastFetchTime = Date.now();

            try {
                // 优先使用本地存储的最后歌曲信息作为反馈参数
                const lastFMSong = this.getLastFMSong();

                const params = {
                    hash: lastFMSong?.hash || this.currentSong?.hash || '',
                    songid: lastFMSong?.songid || this.currentSong?.songid || '',
                    playtime: lastFMSong?.playtime || this.currentSong?.timelen || 0,
                    mode: this.mode,
                    action: 'play',
                    song_pool_id: this.songPoolId,
                    m_type: this.m_type,
                    remain_songcnt: this.pool.length,
                    timestamp: Date.now(),
                    is_overplay: 1
                };

                const response = await get('/personal/fm', params);

                if (response.status === 1 && response.data?.song_list?.length > 0) {
                    // 并行获取所有歌曲的URL
                    const validSongs = await this.fetchSongsWithUrls(response.data.song_list);

                    // 如果当前没有在播放的歌，随机选一首直接播放，其余入池
                    if (!this.currentSong && validSongs.length > 0) {
                        const randomIndex = Math.floor(Math.random() * validSongs.length);
                        this.currentSong = validSongs.splice(randomIndex, 1)[0];
                        this.saveLastFMSong(this.currentSong);
                    }

                    // 剩余歌曲入池
                    for (const song of validSongs) {
                        this.pool.push(song);
                    }

                    // 池子超上限，移除最早的
                    if (this.pool.length > this.maxPoolSize) {
                        this.pool.splice(0, this.pool.length - this.maxPoolSize);
                    }
                }
            } catch (error) {
                console.error('[PersonalFM] 获取私人FM歌曲出错:', error);
            } finally {
                this.isLoading = false;
            }
        },

        // 并行获取歌曲URL
        async fetchSongsWithUrls(songList) {
            const urlPromises = songList.map(async (song) => {
                try {
                    // 检查缓存中是否已有该歌曲的URL
                    if (this.urlCache[song.hash]) {
                        const cachedUrl = this.urlCache[song.hash];
                        if (Date.now() - cachedUrl.timestamp < 3600000) {
                            return {
                                hash: song.hash,
                                name: song.ori_audio_name || song.songname,
                                cover: song.trans_param?.union_cover?.replace("{size}", 480) || '',
                                author: song.author_name,
                                timelen: song.time_length,
                                url: cachedUrl.url,
                                songid: song.songid
                            };
                        } else {
                            delete this.urlCache[song.hash];
                        }
                    }

                    // 获取歌曲URL
                    const settings = JSON.parse(localStorage.getItem('settings') || '{}');
                    const data = { hash: song.hash };

                    const MoeAuth = typeof MoeAuthStore === 'function' ? MoeAuthStore() : { isAuthenticated: false };
                    const isAuth = !!MoeAuth.isAuthenticated;

                    if (!isAuth) {
                        data.free_part = 1;
                    } else {
                        const q = normalizeQuality(settings?.quality);
                        const fallbackChain = getFallbackChain(q);
                        data.quality = fallbackChain[0];
                    }

                    const urlResponse = await get('/song/url', data);

                    if (urlResponse.status === 1 && urlResponse.url && urlResponse.url[0]) {
                        // 缓存URL
                        if (Object.keys(this.urlCache).length >= this.maxCacheSize) {
                            // 清理最旧的缓存
                            const oldestKey = Object.keys(this.urlCache).reduce((a, b) =>
                                this.urlCache[a].timestamp < this.urlCache[b].timestamp ? a : b
                            );
                            delete this.urlCache[oldestKey];
                        }

                        this.urlCache[song.hash] = {
                            url: urlResponse.url[0],
                            timestamp: Date.now()
                        };

                        return {
                            hash: song.hash,
                            name: song.ori_audio_name || song.songname,
                            cover: song.trans_param?.union_cover?.replace("{size}", 480) || '',
                            author: song.author_name,
                            timelen: song.time_length,
                            url: urlResponse.url[0],
                            songid: song.songid
                        };
                    } else {
                        return null;
                    }
                } catch (error) {
                    console.error('[PersonalFM] 获取歌曲URL失败:', song.hash, error);
                    return null;
                }
            });

            const results = await Promise.all(urlPromises);
            return results.filter(song => song !== null);
        },

        // 预加载歌曲
        async preloadSongs() {
            if (!this.canPreload) return;

            this.isPreloading = true;
            try {
                await this.fetchFMSongs();
            } catch (error) {
                console.error('[PersonalFM] 预加载歌曲失败:', error);
            } finally {
                this.isPreloading = false;
            }
        },

        // 清空URL缓存
        clearUrlCache() {
            this.urlCache = {};
        },

        // 设置AI模式
        setSongPoolId(poolId) {
            this.songPoolId = poolId;
        },

        // 设置获取模式
        setMode(mode) {
            this.mode = mode;
            this.m_type = mode === 'normal' ? 0 : 3;
        },

        // 清理过期的URL缓存
        cleanupUrlCache() {
            const now = Date.now();
            const oneHour = 3600000;
            for (const hash in this.urlCache) {
                if (now - this.urlCache[hash].timestamp > oneHour) {
                    delete this.urlCache[hash];
                }
            }
        },

        // 从localStorage恢复URL缓存
        restoreCacheFromStorage() {
            try {
                const cachedData = localStorage.getItem('personalFM_urlCache');
                if (cachedData) {
                    const data = JSON.parse(cachedData);
                    const now = Date.now();
                    const oneHour = 3600000;
                    for (const hash in data) {
                        if (now - data[hash].timestamp < oneHour) {
                            this.urlCache[hash] = data[hash];
                        }
                    }
                }
            } catch (error) {
                console.error('[PersonalFM] 恢复URL缓存失败:', error);
            }
        },

        // 保存缓存到localStorage
        saveCacheToStorage() {
            try {
                localStorage.setItem('personalFM_urlCache', JSON.stringify(this.urlCache));
            } catch (error) {
                console.error('[PersonalFM] 保存URL缓存失败:', error);
            }
        },

        // 在应用关闭前保存缓存
        beforeUnload() {
            this.saveCacheToStorage();
        },
    },

    persist: {
        enabled: true,
        strategies: [
            {
                key: 'PersonalFM',
                storage: localStorage,
                paths: ['isEnabled', 'songPoolId', 'mode', 'm_type', 'pool', 'currentSong', 'history'],
            },
        ],
        beforeRestore: (context) => {
            const store = context.store;
            store.restoreCacheFromStorage();
        },
        afterRestore: (context) => {
            const store = context.store;
            store.cleanupUrlCache();

            // 如果FM模式启用但没有当前歌曲也没有池子，预加载
            if (store.isEnabled && !store.currentSong && store.pool.length === 0) {
                store.preloadSongs();
            }
            // 如果FM模式启用且有池子但低于阈值，预加载
            if (store.isEnabled && store.pool.length > 0 && store.pool.length < store.poolThreshold) {
                store.preloadSongs();
            }
        },
    },
});