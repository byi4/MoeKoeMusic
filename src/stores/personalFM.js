import { defineStore } from 'pinia';
import { get } from '../utils/request';
import { useMusicQueueStore } from './musicQueue';
import { MoeAuthStore } from './store';

export const usePersonalFMStore = defineStore('PersonalFM', {
    state: () => ({
        isEnabled: false, // 是否启用私人FM模式
        songs: [], // 私人FM歌曲列表
        currentIndex: 0, // 当前播放歌曲索引
        isLoading: false, // 是否正在加载歌曲
        maxSongs: 20, // 最大歌曲数量
        songPoolId: 0, // AI模式：0：Alpha 根据口味推荐相似歌曲, 1：Beta 根据风格推荐相似歌曲, 2：Gamma
        mode: 'normal', // 获取模式：normal：发现，small： 小众
        m_type: 0, // 音乐类型：根据mode自动设置，normal→0，small→3
        urlCache: {}, // 使用普通对象缓存歌曲URL，避免重复请求
        maxCacheSize: 5, // 最大缓存歌曲数量
        preloadThreshold: 5, // 剩余5首歌时开始预加载
        isPreloading: false, // 是否正在预加载
        lastFetchTime: 0, // 上次获取歌曲的时间
        fetchCooldown: 30000, // 获取冷却时间30秒，避免频繁请求
    }),
    
    getters: {
        // 获取当前歌曲
        currentSong: (state) => {
            return state.songs[state.currentIndex] || null;
        },
        
        // 获取剩余歌曲数量
        remainingSongs: (state) => {
            return state.songs.length - state.currentIndex - 1;
        },
        
        // 是否需要加载更多歌曲
        needsMoreSongs: (state) => {
            return state.isEnabled && state.remainingSongs < state.preloadThreshold;
        },
        
        // 是否可以预加载（避免频繁请求）
        canPreload: (state) => {
            const now = Date.now();
            return !state.isPreloading &&
                   !state.isLoading &&
                   (now - state.lastFetchTime) > state.fetchCooldown;
        }
    },
    
    actions: {
        // 启用私人FM模式
        async enableFM() {
            this.isEnabled = true;
            this.currentIndex = 0;
            this.songs = [];
            
            // 清空播放列表
            const musicQueueStore = useMusicQueueStore();
            musicQueueStore.clearQueue();
            
            // 启用FM时立即加载一批歌曲
            await this.fetchFMSongs();
        },
        
        // 保存最后一首FM歌曲信息到本地存储
        saveLastFMSong(song) {
            if (!song) return;
            
            // 尝试从私人FM列表中获取完整的歌曲信息，包括songid
            let fmSong = this.songs.find(s => s.hash === song.hash);
            
            // 如果在私人FM列表中找到，使用列表中的信息
            if (fmSong) {
                const lastFMSong = {
                    hash: fmSong.hash,
                    songid: fmSong.songid,
                    playtime: fmSong.timelen || song.timeLength || 0
                };
                
                console.log('[PersonalFM] 保存最后一首FM歌曲信息(从FM列表):', lastFMSong);
                localStorage.setItem('personalFM_lastSong', JSON.stringify(lastFMSong));
            } else {
                // 如果不在私人FM列表中，使用传入的歌曲信息
                const lastFMSong = {
                    hash: song.hash,
                    songid: song.songid || '',
                    playtime: song.timeLength || song.timelen || 0
                };
                
                console.log('[PersonalFM] 保存最后一首FM歌曲信息(从传入歌曲):', lastFMSong);
                localStorage.setItem('personalFM_lastSong', JSON.stringify(lastFMSong));
            }
        },
        
        // 获取本地存储的最后一首FM歌曲信息
        getLastFMSong() {
            try {
                const lastSongStr = localStorage.getItem('personalFM_lastSong');
                if (lastSongStr) {
                    const lastSong = JSON.parse(lastSongStr);
                    console.log('[PersonalFM] 获取本地存储的最后一首FM歌曲信息:', lastSong);
                    return lastSong;
                }
            } catch (error) {
                console.error('[PersonalFM] 获取本地存储的FM歌曲信息出错:', error);
            }
            return null;
        },
        
        // 禁用私人FM模式
        disableFM() {
            this.isEnabled = false;
            this.currentIndex = 0;
            this.songs = [];
        },
        
        // 获取私人FM歌曲
        async fetchFMSongs(currentSong = {}) {
            if (this.isLoading) return;
            
            console.log('[PersonalFM] 开始获取FM歌曲，当前状态:', {
                isEnabled: this.isEnabled,
                currentIndex: this.currentIndex,
                songsLength: this.songs.length,
                maxSongs: this.maxSongs,
                isLoading: this.isLoading
            });
            
            this.isLoading = true;
            this.lastFetchTime = Date.now();
            
            try {
                // 获取私人FM列表中当前播放的歌曲
                const fmCurrentSong = this.currentSong;
                
                console.log('[PersonalFM] 当前FM歌曲:', fmCurrentSong);
                console.log('[PersonalFM] 传入的当前歌曲:', currentSong);
                
                // 尝试获取本地存储的最后一首FM歌曲信息
                const lastFMSong = this.getLastFMSong();
                
                // 构建请求参数
                const params = {
                    hash: lastFMSong?.hash || fmCurrentSong?.hash || currentSong.hash || '',
                    songid: lastFMSong?.songid || fmCurrentSong?.songid || '', // 优先使用本地存储的songid
                    playtime: lastFMSong?.playtime || fmCurrentSong?.timelen || currentSong.timeLength || 0, // 优先使用本地存储的playtime
                    mode: this.mode, // 使用设置的模式
                    action: 'play', // 默认动作
                    song_pool_id: this.songPoolId, // 使用设置的AI模式
                    m_type: this.m_type, // 根据mode自动设置的音乐类型
                    remain_songcnt: 0, // 根据API文档，默认值为0
                    timestamp: Date.now(), // 添加时间戳
                    // 移除is_overplay参数
                    is_overplay: 1
                };
                
                console.log('[PersonalFM] 使用本地存储的最后一首FM歌曲信息:', lastFMSong);
                console.log('[PersonalFM] 请求参数:', params);
                
                const startTime = Date.now();
                const response = await get('/personal/fm', params);
                const endTime = Date.now();
                console.log(`[PersonalFM] /personal/fm 请求耗时: ${endTime - startTime}ms`);
                
                console.log('[PersonalFM] API响应:', response);
                
                if (response.status === 1 && response.data?.song_list?.length > 0) {
                    console.log(`[PersonalFM] 获取到${response.data.song_list.length}首歌曲`);
                    
                    // 并行获取所有歌曲的URL
                    const validSongs = await this.fetchSongsWithUrls(response.data.song_list);
                    
                    console.log(`[PersonalFM] 验证后有${validSongs.length}首有效歌曲`);
                    
                    // 将新歌曲添加到私人FM列表
                    this.songs = [...this.songs, ...validSongs];
                    
                    // 如果列表超过最大数量，删除最早的歌曲
                    if (this.songs.length > this.maxSongs) {
                        const removeCount = this.songs.length - this.maxSongs;
                        console.log(`[PersonalFM] 删除${removeCount}首最早的歌曲`);
                        this.songs.splice(0, removeCount);
                        // 调整当前索引，确保不会变成负数
                        this.currentIndex = Math.max(0, this.currentIndex - removeCount);
                    }
                    
                    // 延迟预加载下一批歌曲的URL，但不添加到歌曲列表
                    setTimeout(() => {
                        this.preloadNextBatchUrls();
                    }, 5000); // 5秒后开始预加载
                } else {
                    console.warn('[PersonalFM] API返回空列表或失败:', response);
                }
            } catch (error) {
                console.error('获取私人FM歌曲出错:', error);
            } finally {
                this.isLoading = false;
            }
        },
        
        // 并行获取歌曲URL
        async fetchSongsWithUrls(songList) {
            console.log('[PersonalFM] 开始并行获取歌曲URL，当前缓存状态:', Object.keys(this.urlCache).length);
            
            const urlPromises = songList.map(async (song) => {
                try {
                    // 检查缓存中是否已有该歌曲的URL
                    if (this.urlCache[song.hash]) {
                        const cachedUrl = this.urlCache[song.hash];
                        // 检查缓存是否过期（假设URL有效期1小时）
                        if (Date.now() - cachedUrl.timestamp < 3600000) {
                            console.log('[PersonalFM] 使用缓存的URL:', song.hash);
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
                            // 缓存过期，删除
                            delete this.urlCache[song.hash];
                            console.log('[PersonalFM] 缓存过期，删除:', song.hash);
                        }
                    }
                    
                    // 获取歌曲URL，添加音质参数
                    const settings = JSON.parse(localStorage.getItem('settings') || '{}');
                    const data = {
                        hash: song.hash
                    };
                    
                    // 根据用户设置确定请求参数
                    const MoeAuth = typeof MoeAuthStore === 'function' ? MoeAuthStore() : { isAuthenticated: false };
                    const isAuth = !!MoeAuth.isAuthenticated;

                    if (!isAuth) {
                        data.free_part = 1;
                    } else {
                        const qualityMap = {
                            normal: '128',
                            high: '320',
                            lossless: 'flac',
                            hires: 'high',
                            viper: 'viper_clear',
                        };

                        const q = settings?.quality;
                        const mapped = qualityMap[q];
                        if (mapped) data.quality = mapped;
                    }
                    
                    const urlResponse = await get('/song/url', data);
                    
                    if (urlResponse.status === 1 && urlResponse.url && urlResponse.url[0]) {
                        // 检查缓存是否已满，如果满了则清空
                        if (Object.keys(this.urlCache).length >= this.maxCacheSize) {
                            console.log('[PersonalFM] 缓存已满，清空缓存');
                            this.urlCache = {};
                        }
                        
                        // 缓存URL
                        this.urlCache[song.hash] = {
                            url: urlResponse.url[0],
                            timestamp: Date.now()
                        };
                        console.log('[PersonalFM] 缓存新URL:', song.hash, '当前缓存数量:', Object.keys(this.urlCache).length);
                        
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
                        console.warn('[PersonalFM] 歌曲URL无效:', song.hash, urlResponse);
                        return null;
                    }
                } catch (error) {
                    console.error('获取歌曲URL失败:', song.hash, error);
                    return null;
                }
            });
            
            // 等待所有URL请求完成
            const results = await Promise.all(urlPromises);
            // 过滤掉无效的歌曲
            const validSongs = results.filter(song => song !== null);
            console.log(`[PersonalFM] 并行获取完成，有效歌曲: ${validSongs.length}/${songList.length}`);
            return validSongs;
        },
        
        // 预加载歌曲
        async preloadSongs() {
            if (!this.canPreload) {
                console.log('[PersonalFM] 不满足预加载条件，跳过预加载');
                return;
            }
            
            console.log('[PersonalFM] 开始预加载歌曲');
            this.isPreloading = true;
            
            try {
                await this.fetchFMSongs();
            } catch (error) {
                console.error('[PersonalFM] 预加载歌曲失败:', error);
            } finally {
                this.isPreloading = false;
            }
        },
        
        // 播放下一首
        playNext() {
            if (this.currentIndex < this.songs.length - 1) {
                this.currentIndex++;
                // 保存当前歌曲信息到本地存储
                this.saveLastFMSong(this.currentSong);
                
                // 检查是否需要预加载更多歌曲
                if (this.needsMoreSongs) {
                    console.log('[PersonalFM] 剩余歌曲不足，触发预加载');
                    // 使用异步方式预加载，不阻塞当前操作
                    this.preloadSongs();
                }
                
                return this.currentSong;
            }
            return null;
        },
        
        // 清空URL缓存
        clearUrlCache() {
            console.log('[PersonalFM] 清空URL缓存，清空前数量:', Object.keys(this.urlCache).length);
            this.urlCache = {};
        },
        
        // 标记不喜欢
        async dislikeSong(songHash) {
            try {
                const currentSong = this.songs.find(s => s.hash === songHash);
                if (!currentSong) return;
                 
                // 调用API标记不喜欢
                await get('/personal/fm', {
                    hash: currentSong.hash,
                    songid: currentSong.songid,
                    playtime: currentSong.timelen || 0, // 使用timelen
                    mode: this.mode,
                    action: 'garbage', // 标记为不喜欢
                    song_pool_id: this.songPoolId,
                    m_type: this.m_type, // 根据mode自动设置的音乐类型
                    remain_songcnt: 0, // 根据API文档，默认值为0
                    timestamp: Date.now(), // 添加时间戳
                    // 移除is_overplay参数
                    is_overplay: 1
                });
                
                // 从列表中移除这首歌
                const index = this.songs.findIndex(s => s.hash === songHash);
                if (index !== -1) {
                    this.songs.splice(index, 1);
                    // 如果移除的是当前播放歌曲之前的歌曲，调整索引
                    if (index < this.currentIndex) {
                        this.currentIndex--;
                    }
                    // 如果移除的是当前播放歌曲，播放下一首
                    else if (index === this.currentIndex) {
                        this.currentIndex = Math.min(this.currentIndex, this.songs.length - 1);
                    }
                }
            } catch (error) {
                console.error('标记不喜欢出错:', error);
            }
        },
        
        // 更新播放进度
        updatePlaytime(playtime) {
            if (this.currentSong) {
                this.currentSong.playtime = playtime;
            }
        },
        
        // 标记歌曲播放完成
        markSongCompleted() {
            if (this.currentSong) {
                this.currentSong.is_overplay = 1;
                // 保存当前歌曲信息到本地存储
                this.saveLastFMSong(this.currentSong);
                
                // 歌曲播放完成时检查是否需要预加载
                if (this.needsMoreSongs) {
                    console.log('[PersonalFM] 歌曲播放完成，剩余歌曲不足，触发预加载');
                    this.preloadSongs();
                }
            }
        },
        
        // 设置AI模式
        setSongPoolId(poolId) {
            this.songPoolId = poolId;
            console.log('[PersonalFM] 设置AI模式为:', poolId);
        },
        
        // 设置获取模式
        setMode(mode) {
            this.mode = mode;
            // 根据mode自动设置m_type
            if (mode === 'normal') {
                this.m_type = 0;
            } else if (mode === 'small') {
                this.m_type = 3;
            }
            console.log('[PersonalFM] 设置获取模式为:', mode, 'm_type为:', this.m_type);
        },
        
        // 清理过期的URL缓存
        cleanupUrlCache() {
            const now = Date.now();
            const oneHour = 3600000;
            let cleanedCount = 0;
            
            for (const hash in this.urlCache) {
                if (now - this.urlCache[hash].timestamp > oneHour) {
                    delete this.urlCache[hash];
                    cleanedCount++;
                }
            }
            
            console.log('[PersonalFM] 清理过期URL缓存完成，清理数量:', cleanedCount, '当前缓存数量:', Object.keys(this.urlCache).length);
        },
        
        // 初始化时恢复缓存数据
        restoreCacheFromStorage() {
            try {
                const cachedData = localStorage.getItem('personalFM_urlCache');
                if (cachedData) {
                    const data = JSON.parse(cachedData);
                    // 恢复缓存数据，但只保留未过期的
                    const now = Date.now();
                    const oneHour = 3600000;
                    let restoredCount = 0;
                    
                    for (const hash in data) {
                        if (now - data[hash].timestamp < oneHour) {
                            this.urlCache[hash] = data[hash];
                            restoredCount++;
                        }
                    }
                    
                    console.log('[PersonalFM] 从本地存储恢复URL缓存，恢复数量:', restoredCount, '当前缓存数量:', Object.keys(this.urlCache).length);
                }
            } catch (error) {
                console.error('[PersonalFM] 恢复URL缓存失败:', error);
            }
        },
        
        // 保存缓存到本地存储
        saveCacheToStorage() {
            try {
                const data = {};
                for (const hash in this.urlCache) {
                    data[hash] = this.urlCache[hash];
                }
                
                localStorage.setItem('personalFM_urlCache', JSON.stringify(data));
                console.log('[PersonalFM] 保存URL缓存到本地存储，数量:', Object.keys(this.urlCache).length);
            } catch (error) {
                console.error('[PersonalFM] 保存URL缓存失败:', error);
            }
        },
        
        // 在应用关闭前保存缓存
        beforeUnload() {
            this.saveCacheToStorage();
        },
        
        // 预加载下一批歌曲的URL（仅缓存URL，不添加到歌曲列表）
        async preloadNextBatchUrls() {
            if (!this.isEnabled || this.isPreloading) return;
            
            console.log('[PersonalFM] 开始预加载下一批歌曲URL');
            
            try {
                // 获取当前播放歌曲
                const currentSong = this.currentSong;
                if (!currentSong) return;
                
                // 构建请求参数
                const params = {
                    hash: currentSong.hash,
                    songid: currentSong.songid || '',
                    playtime: currentSong.timelen || 0,
                    mode: this.mode,
                    action: 'play',
                    song_pool_id: this.songPoolId,
                    m_type: this.m_type, // 根据mode自动设置的音乐类型
                    remain_songcnt: 0, // 根据API文档，默认值为0
                    timestamp: Date.now(), // 添加时间戳
                    is_overplay: 1
                };
                
                const response = await get('/personal/fm', params);
                
                if (response.status === 1 && response.data?.song_list?.length > 0) {
                    console.log(`[PersonalFM] 预加载获取到${response.data.song_list.length}首歌曲`);
                    
                    // 只获取URL并缓存，不添加到歌曲列表
                    const urlPromises = response.data.song_list.map(async (song) => {
                        try {
                            // 检查缓存中是否已有该歌曲的URL
                            if (this.urlCache[song.hash]) {
                                const cachedUrl = this.urlCache[song.hash];
                                // 检查缓存是否过期
                                if (Date.now() - cachedUrl.timestamp < 3600000) {
                                    console.log('[PersonalFM] 预加载：URL已缓存:', song.hash);
                                    return;
                                } else {
                                    // 缓存过期，删除
                                    delete this.urlCache[song.hash];
                                }
                            }
                            
                            // 获取歌曲URL，添加音质参数
                            const settings = JSON.parse(localStorage.getItem('settings') || '{}');
                            const data = {
                                hash: song.hash
                            };
                            
                            // 根据用户设置确定请求参数
                            const MoeAuth = typeof MoeAuthStore === 'function' ? MoeAuthStore() : { isAuthenticated: false };
                            const isAuth = !!MoeAuth.isAuthenticated;

                            if (!isAuth) {
                                data.free_part = 1;
                            } else {
                                const qualityMap = {
                                    normal: '128',
                                    high: '320',
                                    lossless: 'flac',
                                    hires: 'high',
                                    viper: 'viper_clear',
                                };

                                const q = settings?.quality;
                                const mapped = qualityMap[q];
                                if (mapped) data.quality = mapped;
                            }
                            
                            const urlResponse = await get('/song/url', data);
                            
                            if (urlResponse.status === 1 && urlResponse.url && urlResponse.url[0]) {
                                // 检查缓存是否已满，如果满了则清空
                                if (Object.keys(this.urlCache).length >= this.maxCacheSize) {
                                    console.log('[PersonalFM] 预加载：缓存已满，清空缓存');
                                    this.urlCache = {};
                                }
                                
                                // 缓存URL
                                this.urlCache[song.hash] = {
                                    url: urlResponse.url[0],
                                    timestamp: Date.now()
                                };
                                console.log('[PersonalFM] 预加载：缓存新URL:', song.hash);
                            }
                        } catch (error) {
                            console.error('[PersonalFM] 预加载URL失败:', song.hash, error);
                        }
                    });
                    
                    // 等待所有URL预加载完成
                    await Promise.all(urlPromises);
                    console.log('[PersonalFM] 预加载完成，当前缓存数量:', Object.keys(this.urlCache).length);
                }
            } catch (error) {
                console.error('[PersonalFM] 预加载下一批歌曲URL出错:', error);
            }
        }
    },
    
    persist: {
        enabled: true,
        strategies: [
            {
                key: 'PersonalFM',
                storage: localStorage,
                paths: ['isEnabled', 'currentIndex', 'songPoolId', 'mode', 'm_type'],
            },
        ],
        beforeRestore: (context) => {
            // 恢复状态前，先恢复缓存
            const store = context.store;
            store.restoreCacheFromStorage();
        },
        afterRestore: (context) => {
            // 恢复状态后，清理过期缓存
            const store = context.store;
            store.cleanupUrlCache();
            
            // 如果FM模式启用且歌曲列表为空，尝试预加载
            if (store.isEnabled && store.songs.length === 0) {
                console.log('[PersonalFM] FM模式启用但歌曲列表为空，尝试预加载');
                store.preloadSongs();
            }
        },
    },
});