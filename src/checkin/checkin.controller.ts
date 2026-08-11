import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from 'src/decorators/auth.guard';
import { RolesGuard } from 'src/decorators/roles.guard';
import { Roles } from 'src/decorators/roles.decorator';
import { ADMIN_ROLES } from 'src/auth/roles';
import { CheckinService } from './checkin.service';
import { CompleteCheckinDto, SearchCheckinDto } from './dto/checkin.dto';

@ApiTags('checkin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...ADMIN_ROLES)
@Controller('events/:eventId/checkin')
export class CheckinController {
  constructor(private readonly checkinService: CheckinService) {}

  @Get('search')
  @ApiOperation({
    summary: 'Busca inscritos do evento por nome, CPF ou número de inscrição',
  })
  search(@Param('eventId') eventId: string, @Query() query: SearchCheckinDto) {
    return this.checkinService.search(eventId, query.q);
  }

  @Get('queue')
  @ApiOperation({ summary: 'Fila do posto de foto (aguardando e em atendimento)' })
  queue(@Param('eventId') eventId: string) {
    return this.checkinService.queue(eventId);
  }

  @Get('stats')
  @ApiOperation({ summary: 'Contadores do check-in do evento' })
  stats(@Param('eventId') eventId: string) {
    return this.checkinService.stats(eventId);
  }

  @Post(':userId/badge')
  @ApiOperation({ summary: 'Etapa 1 — entrega do crachá; entra na fila' })
  deliverBadge(
    @Param('eventId') eventId: string,
    @Param('userId') userId: string,
    @Req() req: any,
  ) {
    return this.checkinService.deliverBadge(eventId, userId, req.user?.userId);
  }

  @Post('call-next')
  @ApiOperation({ summary: 'Etapa 2 — chama o primeiro da fila' })
  callNext(@Param('eventId') eventId: string, @Req() req: any) {
    return this.checkinService.callNext(eventId, req.user?.userId);
  }

  @Post(':userId/call')
  @ApiOperation({ summary: 'Etapa 2 — chama um participante específico' })
  call(
    @Param('eventId') eventId: string,
    @Param('userId') userId: string,
    @Req() req: any,
  ) {
    return this.checkinService.call(eventId, userId, req.user?.userId);
  }

  @Post(':userId/complete')
  @ApiOperation({ summary: 'Etapa 3 — foto tirada e dados conferidos' })
  complete(
    @Param('eventId') eventId: string,
    @Param('userId') userId: string,
    @Body() body: CompleteCheckinDto,
    @Req() req: any,
  ) {
    return this.checkinService.complete(
      eventId,
      userId,
      req.user?.userId,
      body?.notes,
    );
  }

  @Post(':userId/undo')
  @ApiOperation({ summary: 'Desfaz a última etapa do check-in' })
  undo(@Param('eventId') eventId: string, @Param('userId') userId: string) {
    return this.checkinService.undo(eventId, userId);
  }
}
