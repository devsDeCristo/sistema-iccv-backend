import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ChurchModule } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { ROLES_KEY } from 'src/decorators/roles.decorator';
import { isSuperAdmin } from 'src/auth/tenant';
import { MODULO_KEY, exigirModulo } from './modulos';

/**
 * Fecha as rotas de um módulo para a igreja cujo plano não o inclui. Vai no fim
 * do `@UseGuards` do controller, depois do login e do recorte por igreja — se
 * fosse global, rodaria antes do login e um anônimo leria na recusa o nome da
 * igreja. Só age na rota marcada com `@Modulo(...)`.
 *
 * O plano recorta o **painel**: rota sem `@Roles` é área do usuário (ver o
 * evento, inscrever-se, pagar a própria inscrição) e passa — o evento já
 * publicado segue aberto ao público mesmo com Eventos fora do plano.
 *
 * Recorta quem trabalha na igreja (admin, financeiro). Dev e super admin veem
 * todos os módulos de todas as igrejas: o plano não vale para eles.
 *
 * A igreja sai da rota: `:churchId`; o evento (`:idEvent`, `:eventId`, ou
 * `:id` nas rotas de Eventos); o pagamento (`:paymentId`); a notícia (`:id`
 * nas rotas de Notícias); ou o `churchId` do corpo. Sem nada disso (listas de
 * várias igrejas, criação sem igreja escolhida), passa — a criação confere
 * no service, depois de saber a igreja.
 */
@Injectable()
export class ModuloGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const alvos = [context.getHandler(), context.getClass()];
    const modulo = this.reflector.getAllAndOverride<ChurchModule>(
      MODULO_KEY,
      alvos,
    );
    if (!modulo) return true;

    const perfis = this.reflector.getAllAndOverride<number[]>(ROLES_KEY, alvos);
    if (!perfis?.length) return true;

    const request = context.switchToHttp().getRequest();
    // o perfil lido do banco pelo `RolesGuard`, que roda antes (rota com
    // `@Roles`); o do token pode estar atrasado
    if (isSuperAdmin({ role: request.user?.role })) return true;

    const churchId = await this.igrejaDaRota(request, modulo);
    if (churchId) await exigirModulo(this.prisma, churchId, modulo);
    return true;
  }

  private async igrejaDaRota(
    request: any,
    modulo: ChurchModule,
  ): Promise<string | null> {
    const p = request.params ?? {};
    if (p.churchId ?? p.idChurch) return p.churchId ?? p.idChurch;

    let eventId =
      p.idEvent ?? p.eventId ?? (modulo === ChurchModule.EVENTS ? p.id : null);
    if (!eventId && p.paymentId) {
      const pagamento = await this.prisma.payment.findUnique({
        where: { id: p.paymentId },
        select: { eventId: true },
      });
      eventId = pagamento?.eventId ?? null;
    }
    if (eventId) {
      const evento = await this.prisma.event.findUnique({
        where: { id: eventId },
        select: { churchId: true },
      });
      return evento?.churchId ?? null;
    }

    if (modulo === ChurchModule.NEWS && p.id) {
      const noticia = await this.prisma.news.findUnique({
        where: { id: p.id },
        select: { churchId: true },
      });
      return noticia?.churchId ?? null;
    }

    const doCorpo = request.body?.churchId;
    return typeof doCorpo === 'string' && doCorpo ? doCorpo : null;
  }
}
