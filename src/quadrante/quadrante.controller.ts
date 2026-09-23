import { Controller, Get, Param, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from 'src/decorators/auth.guard';
import { RolesGuard } from 'src/decorators/roles.guard';
import { EventTenantGuard } from 'src/decorators/event-tenant.guard';
import { Roles } from 'src/decorators/roles.decorator';
import { ADMIN_ROLES } from 'src/auth/roles';
import { QuadranteService } from './quadrante.service';

@ApiTags('quadrante')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, EventTenantGuard)
@Roles(...ADMIN_ROLES)
@Controller('events/:idEvent/quadrante')
export class QuadranteController {
  constructor(private readonly quadranteService: QuadranteService) {}

  @Get('pdf')
  async generatePdf(
    @Param('idEvent') idEvent: string,
    @Res() res: Response,
  ) {
    const { buffer, fileName } =
      await this.quadranteService.generatePdf(idEvent);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${fileName}"`,
    );
    res.send(buffer);
  }
}
