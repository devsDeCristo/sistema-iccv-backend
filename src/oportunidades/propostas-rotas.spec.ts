import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { OportunidadesModule } from './oportunidades.module';
import { OportunidadesService } from './oportunidades.service';
import { JwtAuthGuard } from 'src/decorators/auth.guard';
import { PrismaService } from 'src/prisma/prisma.service';

/**
 * A ordem real dos controllers do módulo: `GET /oportunidades/:id` (com
 * `ParseUUIDPipe`) registrado antes de `/oportunidades/propostas` responderia
 * 400 a quem abre as próprias propostas.
 */
it('rotas: /oportunidades/propostas não cai em /oportunidades/:id', async () => {
  const controllers = Reflect.getMetadata('controllers', OportunidadesModule);
  const servico = {
    minhasPropostas: jest.fn(async () => []),
    detalhe: jest.fn(),
  };
  const mod = await Test.createTestingModule({
    controllers,
    providers: [
      { provide: OportunidadesService, useValue: servico },
      { provide: PrismaService, useValue: {} },
    ],
  })
    .overrideGuard(JwtAuthGuard)
    .useValue({
      canActivate: (c: any) => (
        (c.switchToHttp().getRequest().user = { userId: 'u' }), true
      ),
    })
    .compile();
  const app: INestApplication = mod.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();
  await request(app.getHttpServer())
    .get('/oportunidades/propostas')
    .expect(200);
  expect(servico.minhasPropostas).toHaveBeenCalledWith('u');
  expect(servico.detalhe).not.toHaveBeenCalled();
  await app.close();
});
