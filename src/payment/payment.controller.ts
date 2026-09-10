import {
  Body,
  Controller,
  Get,
  Param,
  Query,
  Patch,
  Post,
  Put,
  Req,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { PaymentService } from './payment.service';
import { CreatePaymentDto } from './dto/create-payment.dto';

import {
  ApiBearerAuth,
  ApiConsumes,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from 'src/decorators/auth.guard';
import { RolesGuard } from 'src/decorators/roles.guard';
import { EventTenantGuard } from 'src/decorators/event-tenant.guard';
import { Roles } from 'src/decorators/roles.decorator';
import { ADMIN_AREA_ROLES } from 'src/auth/roles';
import {
  CreatePaymentCheckoutDto,
  payloadCreatePaymentCheckoutDto,
} from './dto/create-payment-checkout.dto';
import { UpdatePaymentStatusDto } from './dto/update-payment-status.dto';
import { ListPaymentLogsDto } from './dto/list-payment-logs.dto';
import { FileFieldsInterceptor } from '@nestjs/platform-express';

@ApiTags('payments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, EventTenantGuard)
@Controller()
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

  // ===============================
  // Criar pagamento (usuário no evento)
  // ===============================
  @ApiOperation({ summary: 'Create payment checkout for user in event' })
  @Post('events/:idEvent/users/:idUser/payments')
  async create(
    @Param('idEvent') eventId: string,
    @Param('idUser') userId: string,
    @Body() body: payloadCreatePaymentCheckoutDto,
    @Req() req: any,
  ) {
    await this.paymentService.assertCanSeePayments(req.user?.userId, userId);

    return this.paymentService.createCheckout({
      userId,
      eventId,
      roleRegistrationId: body.roleRegistrationId,
    });
  }

  // ===============================
  // Pagamentos por evento
  // ===============================
  @ApiOperation({ summary: 'Get payments by event' })
  @Roles(...ADMIN_AREA_ROLES)
  @Get('events/:idEvent/payments')
  findByEvent(@Param('idEvent') eventId: string) {
    return this.paymentService.findPaymentsByEvent(eventId);
  }

  // ===============================
  // Trilha do dinheiro do evento
  // ===============================
  /**
   * Antes de `events/:idEvent/users/:idUser/payments` não faz diferença — os
   * caminhos não se sobrepõem —, mas fica junto da listagem de pagamentos,
   * que é a tela de onde se chega aqui.
   *
   * O recorte por igreja vem do `EventTenantGuard`: quem não administra a
   * igreja do evento não passa, e o financeiro de uma igreja não enxerga o
   * caixa da outra.
   */
  @ApiOperation({
    summary: 'Histórico de alterações no dinheiro do evento',
    description:
      'Toda mudança em cobrança e checkout, inclusive as feitas pela reconciliação automática e pelo retorno do PagBank.',
  })
  @Roles(...ADMIN_AREA_ROLES)
  @Get('events/:idEvent/payments/logs')
  findLogsByEvent(
    @Param('idEvent') eventId: string,
    @Query() query: ListPaymentLogsDto,
  ) {
    return this.paymentService.findPaymentLogs(eventId, query);
  }

  // ===============================
  // Pagamentos por usuário no evento
  // ===============================
  @ApiOperation({ summary: 'Get payments by user in event' })
  @Get('events/:idEvent/users/:idUser/payments')
  async findByUserEvent(
    @Param('idEvent') eventId: string,
    @Param('idUser') userId: string,
    @Req() req: any,
  ) {
    await this.paymentService.assertCanSeePayments(req.user?.userId, userId);
    return this.paymentService.findPaymentsByUser(userId, eventId);
  }

  @ApiOperation({ summary: 'Get payments by user' })
  @Get('users/:idUser/payments')
  async findByUser(@Param('idUser') userId: string, @Req() req: any) {
    await this.paymentService.assertCanSeePayments(req.user?.userId, userId);
    return this.paymentService.findUserEventsWithRoles(
      userId,
      req.user?.userId,
    );
  }

  // ===============================
  // Atualizar status do pagamento
  // ===============================

  @ApiOperation({ summary: 'Update payment' })
  @Roles(...ADMIN_AREA_ROLES)
  @Put('payments/:paymentId')
  @UseInterceptors(
    FileFieldsInterceptor([{ name: 'receiptFile', maxCount: 1 }]),
  )
  @ApiConsumes('multipart/form-data')
  update(
    @Param('paymentId') paymentId: string,
    @UploadedFiles()
    files: {
      receiptFile?: Express.Multer.File[];
    },
    @Body() body: UpdatePaymentStatusDto,
  ) {
    const receiptFile = files.receiptFile?.[0];
    body.receiptFile = receiptFile;
    body.paymentId = paymentId;
    return this.paymentService.updatePaymentStatus(body);
  }

  // ===============================
  // Reembolso
  // ===============================
  @ApiOperation({ summary: 'Refund payment' })
  @Roles(...ADMIN_AREA_ROLES)
  @Patch('payments/:paymentId/refund')
  refund(@Param('paymentId') paymentId: string) {
    return this.paymentService.refundPayment(paymentId);
  }

  // ===============================
  // Gambis
  // ===============================
  @ApiOperation({ summary: 'Get discounts' })
  @Get('discounts')
  getDiscounts() {
    return this.paymentService.getDiscounts();
  }
}
