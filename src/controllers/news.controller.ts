import { Request, Response } from 'express';
import { newsService } from '../services/news.service.js';
import {
  SaveDailyNewsRequest,
  SaveMonthlyNewsRequest,
  UpdateNewsConfigRequest,
  NewsResponse,
} from '../types/news.js';

/**
 * @desc 일일 뉴스 조회
 * @route GET /api/news/daily/:guildId
 * @access Protected
 */
export const getDailyNews = async (
  req: Request<{ guildId: string }>,
  res: Response<NewsResponse>,
) => {
  try {
    const { guildId } = req.params;
    const dateStr = req.query.date as string;
    const newsDate = dateStr ? new Date(dateStr) : new Date();

    const news = await newsService.findDailyNews(guildId, newsDate);

    if (!news) {
      return res.status(404).json({
        status: 'error',
        message: 'Daily news not found',
        data: null,
      });
    }

    return res.status(200).json({
      status: 'success',
      message: 'Daily news retrieved successfully',
      data: news,
    });
  } catch (error) {
    console.error('Error retrieving daily news:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error while retrieving daily news',
      data: null,
    });
  }
};

/**
 * @desc 일일 뉴스 저장
 * @route POST /api/news/daily
 * @access Protected (배치에서 호출)
 */
export const saveDailyNews = async (
  req: Request<Record<string, never>, NewsResponse, SaveDailyNewsRequest>,
  res: Response<NewsResponse>,
) => {
  try {
    const data = req.body;
    const saved = await newsService.saveDailyNews(data);

    res.status(201).json({
      status: 'success',
      message: 'Daily news saved successfully',
      data: saved,
    });
  } catch (error) {
    console.error('Error saving daily news:', error);
    res.status(500).json({
      status: 'error',
      message: 'Internal server error while saving daily news',
      data: null,
    });
  }
};

/**
 * @desc 월간 뉴스 조회
 * @route GET /api/news/monthly/:guildId
 * @access Protected
 */
export const getMonthlyNews = async (
  req: Request<{ guildId: string }>,
  res: Response<NewsResponse>,
) => {
  try {
    const { guildId } = req.params;
    const year = parseInt(req.query.year as string) || new Date().getFullYear();
    const month = parseInt(req.query.month as string) || new Date().getMonth() + 1;

    const news = await newsService.findMonthlyNews(guildId, year, month);

    if (!news) {
      return res.status(404).json({
        status: 'error',
        message: 'Monthly news not found',
        data: null,
      });
    }

    return res.status(200).json({
      status: 'success',
      message: 'Monthly news retrieved successfully',
      data: news,
    });
  } catch (error) {
    console.error('Error retrieving monthly news:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error while retrieving monthly news',
      data: null,
    });
  }
};

/**
 * @desc 월간 뉴스 저장
 * @route POST /api/news/monthly
 * @access Protected (배치에서 호출)
 */
export const saveMonthlyNews = async (
  req: Request<Record<string, never>, NewsResponse, SaveMonthlyNewsRequest>,
  res: Response<NewsResponse>,
) => {
  try {
    const data = req.body;
    const saved = await newsService.saveMonthlyNews(data);

    res.status(201).json({
      status: 'success',
      message: 'Monthly news saved successfully',
      data: saved,
    });
  } catch (error) {
    console.error('Error saving monthly news:', error);
    res.status(500).json({
      status: 'error',
      message: 'Internal server error while saving monthly news',
      data: null,
    });
  }
};

/**
 * @desc 뉴스 설정 조회
 * @route GET /api/news/config/:guildId
 * @access Protected
 */
export const getNewsConfig = async (
  req: Request<{ guildId: string }>,
  res: Response<NewsResponse>,
) => {
  try {
    const { guildId } = req.params;
    const config = await newsService.findConfig(guildId);

    return res.status(200).json({
      status: 'success',
      message: config ? 'Config retrieved successfully' : 'No config found, using defaults',
      data: config,
    });
  } catch (error) {
    console.error('Error retrieving news config:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error while retrieving config',
      data: null,
    });
  }
};

/**
 * @desc 뉴스 설정 수정
 * @route PUT /api/news/config/:guildId
 * @access Protected
 */
export const updateNewsConfig = async (
  req: Request<{ guildId: string }, NewsResponse, UpdateNewsConfigRequest>,
  res: Response<NewsResponse>,
) => {
  try {
    const { guildId } = req.params;
    const data = req.body;

    const config = await newsService.upsertConfig(guildId, data);

    res.status(200).json({
      status: 'success',
      message: 'Config updated successfully',
      data: config,
    });
  } catch (error) {
    console.error('Error updating news config:', error);
    res.status(500).json({
      status: 'error',
      message: 'Internal server error while updating config',
      data: null,
    });
  }
};
