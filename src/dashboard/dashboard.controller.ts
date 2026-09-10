import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from 'src/decorators/auth.guard';
import { RolesGuard } from 'src/decorators/roles.guard';
import { Roles } from 'src/decorators/roles.decorator';
import { ADMIN_AREA_ROLES } from 'src/auth/roles';
import { DashboardService } from './dashboard.service';

/**
 * Tela de abertura do painel. A rota é uma só para os quatro perfis que entram
 * lá: o que muda é o conteúdo, montado no serviço a partir do recorte de quem
 * pediu. Uma rota por perfil espalharia a mesma regra de tenant por quatro
 * lugares, e é assim que uma delas fica para trás.
 */
@ApiTags('dashboard')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...ADMIN_AREA_ROLES)
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @ApiOperation({ summary: 'Resumo de abertura do painel administrativo' })
  @Get()
  overview(@Req() req: any) {
    return this.dashboardService.overview(req.user?.userId);
  }
}
