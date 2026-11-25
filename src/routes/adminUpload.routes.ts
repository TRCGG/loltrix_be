import { Router } from 'express';
import { z } from 'zod';
import { validateRequest } from '../middlewares/validateRequest.js';
import { requireAdmin } from '../middlewares/requireRole.js';
import { rejectBot } from '../middlewares/rejectBot.js';
import { createImageUpload } from '../controllers/adminUpload.controller.js';
import { IMAGE_CONTENT_TYPES, ImageContentType } from '../types/imageUpload.js';

export const imageUploadSchema = z.object({
  body: z.object({
    contentType: z.enum(
      Object.keys(IMAGE_CONTENT_TYPES) as [ImageContentType, ...ImageContentType[]],
    ),
  }),
});

const router: Router = Router();

router.use(rejectBot('Bot cannot upload images'), requireAdmin('adminNormal'));

/**
 * @route POST /api/admin/uploads/images
 * @desc 게시판 이미지 업로드 허가 발급 (S3 presigned POST)
 * @access adminNormal 이상
 */
router.post(
  '/images',
  /* #swagger.tags = ['Post']
    #swagger.summary = '게시판 이미지 업로드 허가 발급'
    #swagger.description = 'S3에 직접 올릴 presigned POST를 발급합니다 (adminNormal 이상, 봇 403). 브라우저는 url로 multipart/form-data POST를 보내며, fields를 모두 파일보다 앞에 넣고 마지막에 file 필드를 붙입니다. 허가는 5분 뒤 만료되고, 10MB 초과·다른 Content-Type은 S3가 거부합니다. 업로드가 끝나면 publicUrl을 본문에 넣습니다. 글을 저장할 때 본문의 이미지가 확정되며, 저장하지 않은 이미지는 1~2일 뒤 지워집니다.'
    #swagger.security = [{ "cookieAuth": [] }]
    #swagger.parameters['body'] = {
      in: 'body',
      required: true,
      schema: { contentType: 'image/webp' }
    }
    #swagger.responses[201] = {
      description: '발급 성공',
      schema: {
        status: 'success',
        message: 'Upload ticket issued successfully',
        data: {
          url: 'https://amzn-s3-gmok-bucket.s3.ap-northeast-2.amazonaws.com/',
          fields: { key: 'prod/board/2026/11/3f2a….webp', 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=31536000, immutable', tagging: '<Tagging>…</Tagging>', Policy: '…', 'X-Amz-Signature': '…' },
          publicUrl: 'https://img.gmok.kr/prod/board/2026/11/3f2a….webp'
        }
      }
    }
    #swagger.responses[400] = { description: '허용하지 않는 contentType (webp·png·jpeg만)' }
    #swagger.responses[403] = { description: '봇 요청 또는 admin 권한 없음' }
    #swagger.responses[503] = { description: '서버에 S3 설정이 없음', schema: { status: 'error', message: 'Image upload is not configured', data: null } }
  */
  validateRequest(imageUploadSchema),
  createImageUpload,
);

export default router;
