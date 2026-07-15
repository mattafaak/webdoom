#include <stdio.h>
#include <stdint.h>
#include <math.h>
static uint8_t pal[768], cm[34*256];
static int nearest(double r,double g,double b,int metric){
    int best=0; double bd=1e30;
    for(int j=0;j<256;j++){
        double dr=pal[j*3]-r, dg=pal[j*3+1]-g, db=pal[j*3+2]-b, d;
        if(metric==0) d=dr*dr+dg*dg+db*db;                    // euclidean
        else if(metric==1) d=fabs(dr)+fabs(dg)+fabs(db);      // manhattan
        else d=0.299*dr*dr+0.587*dg*dg+0.114*db*db;           // luma-weighted
        if(d<bd){bd=d;best=j;}
    }
    return best;
}
int main(int argc,char**argv){
    FILE*fp=fopen(argv[1],"rb"); fread(pal,1,768,fp); fclose(fp);
    fp=fopen(argv[2],"rb"); fread(cm,1,34*256,fp); fclose(fp);
    const char* mn[]={"euclid","manhat","luma  "};
    for(int metric=0;metric<3;metric++){
        // scale variants: try (32-L)/32, and with round vs trunc
        for(int sv=0;sv<4;sv++){
            int total=0, exact_levels=0;
            for(int L=0;L<32;L++){
                double scale;
                switch(sv){
                  case 0: scale=(32.0-L)/32.0; break;
                  case 1: scale=(31.0-L)/31.0; break;
                  case 2: scale=(32.0-L)/32.0; break; // + round handled below
                  case 3: scale=(63.0-2*L)/64.0; break;
                }
                int bad=0;
                for(int i=0;i<256;i++){
                    double r=pal[i*3]*scale, g=pal[i*3+1]*scale, b=pal[i*3+2]*scale;
                    if(sv==2){r=floor(r+0.5);g=floor(g+0.5);b=floor(b+0.5);}
                    if(nearest(r,g,b,metric)!=cm[L*256+i]) bad++;
                }
                total+=bad; if(!bad)exact_levels++;
            }
            printf("metric=%s scale=%d: %d/8192 mismatches, %d/32 exact levels\n",
                   mn[metric],sv,total,exact_levels);
        }
    }
    return 0;
}
