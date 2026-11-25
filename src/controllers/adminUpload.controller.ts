import { NextFunction, Response } from 'express';
import { AuthRequest } from '../middlewares/authHandler.js';
import { imageUploadService } from '../services/imageUpload.service.js';
import { BusinessError } from '../types/error.js';
import { ImageContentType, ImageUploadTicket } from '../types/imageUpload.js';

interface UploadResponse {
  status: 'success' | 'error';
  message: string;
  data: ImageUploadTicket | null;
}

/**
 * @desc 게시판 이미지 업로드 허가 발급 (S3 presigned POST)
 * @route POST /api/admin/uploads/images
 * @access adminNormal 이상
 */
export const createImageUpload = async (
  req: AuthRequest,
  res: Response<UploadResponse>,
  next: NextFunction,
) => {
  try {
    const { contentType } = req.body as { contentType: ImageContentType };
    const data = await imageUploadService.createUploadTicket(contentType);
    return res
      .status(201)
      .json({ status: 'success', message: 'Upload ticket issued successfully', data });
  } catch (error) {
    // 프론트는 에러 본문의 message를 읽는다. 오류 처리기의 ProblemDetails에는 message가 없다.
    if (error instanceof BusinessError) {
      return res.status(error.status).json({ status: 'error', message: error.message, data: null });
    }
    return next(error);
  }
};
