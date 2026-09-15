import { Router } from 'express';
import { getChampions } from '../controllers/champion.controller.js';

const router: Router = Router();

/**
 * @route GET /api/champions
 * @desc 챔피언 목록 조회
 */
router.get(
  '/',
  /* #swagger.auto = false
    #swagger.tags = ['Champion']
    #swagger.summary = '챔피언 목록 조회'
    #swagger.description = '삭제되지 않은 챔피언 전체를 한글 이름순으로 반환합니다. 대회 신청의 champions에 넣을 id를 여기서 얻습니다. riotKey는 Data Dragon 이미지·데이터 조회용 라이엇 챔피언 key이며, 아직 채워지지 않은 신규 챔피언은 null입니다.'
    #swagger.security = [{ "session": [] }]
    #swagger.responses[200] = {
      description: '조회 성공. 파라미터 없이 전체 목록을 반환합니다.',
      schema: {
        status: 'success',
        message: 'Champions retrieved successfully',
        data: [
          { id: 'CHN_1', champName: '아트록스', champNameEng: 'Aatrox', riotKey: 266 }
        ]
      }
    }
    #swagger.responses[401] = { description: '미인증 (세션 없음)', schema: { status: 'error', message: 'Unauthorized', data: null } }
  */
  getChampions,
);

export default router;
