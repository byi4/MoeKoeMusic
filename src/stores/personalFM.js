import { defineStore } from 'pinia';
import { get } from '../utils/request';
import { useMusicQueueStore } from './musicQueue';

export const usePersonalFMStore = defineStore('PersonalFM', {
    state: () => ({
        isEnabled: false, // 是否启用私人FM模式
        songs: [], // 私人FM歌曲列表
        currentIndex: 0, // 当前播放歌曲索引
        isLoading: false, // 是否正在加载歌曲
        maxSongs: 20, // 最大歌曲数量
        songPoolId: 0, // AI模式：0：Alpha 根据口味推荐相似歌曲, 1：Beta 根据风格推荐相似歌曲, 2：Gamma
        mode: 'normal', // 获取模式：normal：发现，small： 小众
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
            return state.isEnabled && state.remainingSongs < 3;
        }
    },
    
    actions: {
        // 启用私人FM模式
        enableFM() {
            this.isEnabled = true;
            this.currentIndex = 0;
            this.songs = [];
            
            // 清空播放列表
            const musicQueueStore = useMusicQueueStore();
            musicQueueStore.clearQueue();
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
                    remain_songcnt: 0, // 根据API文档，默认值为0
                    timestamp: Date.now(), // 添加时间戳
                    // 移除is_overplay参数
                    is_overplay: 1
                };
                
                console.log('[PersonalFM] 使用本地存储的最后一首FM歌曲信息:', lastFMSong);

                console.log('[PersonalFM] 请求参数:', params);

                const response = await get('/personal/fm', params);
                
                console.log('[PersonalFM] API响应:', response);
                
                if (response.status === 1 && response.data?.song_list?.length > 0) {
                    console.log(`[PersonalFM] 获取到${response.data.song_list.length}首歌曲`);
                    
                    // 验证歌曲URL并过滤出可播放的歌曲
                    const validSongs = [];
                    
                    for (const song of response.data.song_list) {
                        try {
                            // 获取歌曲URL
                            const urlResponse = await get('/song/url', {
                                hash: song.hash
                            });
                            
                            if (urlResponse.status === 1 && urlResponse.url && urlResponse.url[0]) {
                                validSongs.push({
                                    hash: song.hash,
                                    name: song.ori_audio_name || song.songname,
                                    cover: song.trans_param?.union_cover?.replace("{size}", 480) || '',
                                    author: song.author_name,
                                    timelen: song.time_length,
                                    url: urlResponse.url[0],
                                    songid: song.songid
                                });
                            } else {
                                console.warn('[PersonalFM] 歌曲URL无效:', song.hash, urlResponse);
                            }
                        } catch (error) {
                            console.error('获取歌曲URL失败:', song.hash, error);
                        }
                    }
                    
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
                } else {
                    console.warn('[PersonalFM] API返回空列表或失败:', response);
                }
            } catch (error) {
                console.error('获取私人FM歌曲出错:', error);
            } finally {
                this.isLoading = false;
            }
        },
        
        // 播放下一首
        playNext() {
            if (this.currentIndex < this.songs.length - 1) {
                this.currentIndex++;
                // 保存当前歌曲信息到本地存储
                this.saveLastFMSong(this.currentSong);
                return this.currentSong;
            }
            return null;
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
            console.log('[PersonalFM] 设置获取模式为:', mode);
        }
    },
    
    persist: {
        enabled: true,
        strategies: [
            {
                key: 'PersonalFM',
                storage: localStorage,
                paths: ['isEnabled', 'currentIndex', 'songPoolId', 'mode'],
            },
        ],
    },
});