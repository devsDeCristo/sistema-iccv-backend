import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PaymentProvider } from '@prisma/client';
import { JwtAuthGuard } from 'src/decorators/auth.guard';
import { RolesGuard } from 'src/decorators/roles.guard';
import { ChurchTenantGuard } from 'src/decorators/church-tenant.guard';
import { Roles } from 'src/decorators/roles.decorator';
import { ADMIN_ROLES, SUPER_ADMIN_ROLES } from 'src/auth/roles';
import { PaymentProviderService } from './payment-provider.service';
import { UpsertPaymentProviderDto } from './dto/upsert-payment-provider.dto';
import { SetPaymentModuleDto } from './dto/set-payment-module.dto';
import { ProviderSlugPipe } from './provider-slug.pipe';

/**
 * Configuração de cobrança da igreja.
 *
 * É a rota mais sensível do sistema: quem escreve aqui decide para qual conta
 * bancária vai o dinheiro dos inscritos. Três coisas a fecham, e as três
 * precisam valer juntas:
 *
 * - `@Roles(...ADMIN_ROLES)` — o financeiro não entra. Quem dá baixa em
 *   pagamento não é quem escolhe a conta que recebe.
 * - `ChurchTenantGuard` — admin de uma igreja não alcança a configuração da
 *   outra, mesmo trocando o `:churchId` da URL na mão.
 * - Nenhuma resposta devolve credencial. Nem a cifrada.
 */
@ApiTags('payment-providers')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, ChurchTenantGuard)
@Roles(...ADMIN_ROLES)
@Controller()
export class PaymentProviderController {
  constructor(private readonly service: PaymentProviderService) {}

  /**
   * O catálogo das integrações disponíveis e os campos que cada uma pede.
   * Sem igreja no caminho: é metadado do sistema, igual para todas.
   */
  @ApiOperation({ summary: 'Integrações de pagamento disponíveis' })
  @Get('payment-providers/catalog')
  catalogo() {
    return this.service.catalogo();
  }

  @ApiOperation({
    summary: 'Integrações de pagamento da igreja',
    description:
      'Traz o estado de cada casa e as URLs de notificação prontas para cadastrar no painel do provedor. Credenciais voltam sempre mascaradas.',
  })
  @Get('churches/:churchId/payment-providers')
  listar(@Param('churchId') churchId: string) {
    return this.service.listar(churchId);
  }

  @ApiOperation({
    summary: 'Salva as credenciais de uma integração',
    description:
      'Campo secreto enviado em branco mantém o valor já gravado — não é preciso redigitar o token para mudar de ambiente.',
  })
  /**
   * Liga e desliga o módulo de cobrança da igreja.
   *
   * `@Roles(...SUPER_ADMIN_ROLES)` sobrescreve o `ADMIN_ROLES` da classe: isto
   * substitui uma variável de ambiente, que só quem opera o sistema mexia.
   * Deixar o admin da igreja desligar daria a ele um jeito de parar a
   * reconciliação das cobranças que ele mesmo abriu.
   *
   * Vem antes das rotas de `:provider` no arquivo por organização, não por
   * necessidade: `module` é um segmento e `:provider/default` são dois, então
   * não há como uma casar no lugar da outra.
   */
  @ApiOperation({ summary: 'Ligar ou desligar a cobrança online da igreja' })
  @Roles(...SUPER_ADMIN_ROLES)
  @Patch('churches/:churchId/payment-providers/module')
  definirModulo(
    @Param('churchId') churchId: string,
    @Body() dto: SetPaymentModuleDto,
  ) {
    return this.service.definirModulo(churchId, dto.enabled);
  }

  @Put('churches/:churchId/payment-providers/:provider')
  salvar(
    @Param('churchId') churchId: string,
    @Param('provider', ProviderSlugPipe) provider: PaymentProvider,
    @Body() dto: UpsertPaymentProviderDto,
    @Req() req: any,
  ) {
    return this.service.salvar(churchId, provider, dto, req.user?.userId);
  }

  @ApiOperation({ summary: 'Define a integração padrão da igreja' })
  @Patch('churches/:churchId/payment-providers/:provider/default')
  definirPadrao(
    @Param('churchId') churchId: string,
    @Param('provider', ProviderSlugPipe) provider: PaymentProvider,
  ) {
    return this.service.definirPadrao(churchId, provider);
  }

  @ApiOperation({
    summary: 'Testa a credencial contra a API da casa',
    description:
      'Não movimenta dinheiro: só confirma que a credencial é aceita.',
  })
  @Post('churches/:churchId/payment-providers/:provider/test')
  @HttpCode(200)
  testar(
    @Param('churchId') churchId: string,
    @Param('provider', ProviderSlugPipe) provider: PaymentProvider,
  ) {
    return this.service.testar(churchId, provider);
  }

  @ApiOperation({
    summary: 'Gera um novo segredo para a URL de notificação',
    description:
      'A URL antiga para de ser aceita na hora. Cadastre a nova no painel do provedor em seguida.',
  })
  @Post('churches/:churchId/payment-providers/:provider/webhook-secret')
  @HttpCode(200)
  rotacionar(
    @Param('churchId') churchId: string,
    @Param('provider', ProviderSlugPipe) provider: PaymentProvider,
    @Req() req: any,
  ) {
    return this.service.rotacionarSegredo(churchId, provider, req.user?.userId);
  }

  @ApiOperation({ summary: 'Remove a credencial de uma integração' })
  @Delete('churches/:churchId/payment-providers/:provider')
  @HttpCode(204)
  async remover(
    @Param('churchId') churchId: string,
    @Param('provider', ProviderSlugPipe) provider: PaymentProvider,
  ) {
    await this.service.remover(churchId, provider);
  }
}
